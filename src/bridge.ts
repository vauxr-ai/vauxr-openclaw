import WebSocket from "ws";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

/** Vauxr protocol frames sent by vauxr to the channel plugin */
interface VauxrInboundFrame {
  type: "channel.transcript" | "channel.device_state" | "channel.ready" | "error";
  deviceId?: string;
  text?: string;
  state?: string;
  name?: string;
  code?: string;
  message?: string;
}

/** Vauxr protocol frames sent by the channel plugin to vauxr */
type VauxrOutboundFrame =
  | { type: "channel.auth"; token: string }
  | { type: "channel.response.delta"; deviceId: string; runId: string; text: string }
  | { type: "channel.response.end"; deviceId: string; runId: string }
  | { type: "channel.response.error"; deviceId: string; runId: string; message: string };

interface VauxrBridgeConfig {
  url: string;
  token?: string;
  voiceSystemPrompt?: string;
}

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

export class VauxrBridge {
  private ws: WebSocket | null = null;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private activeRuns = new Map<string, string>(); // SDK runId → deviceId
  private runIdMap = new Map<string, string>(); // SDK runId → protocol runId
  private wsUrl: string;

  constructor(
    private api: OpenClawPluginApi,
    private config: VauxrBridgeConfig,
  ) {
    // Derive WS URL from HTTP base URL
    const base = config.url.replace(/\/$/, "");
    this.wsUrl = base.replace(/^http/, "ws") + "/channel";
  }

  start(): void {
    this.connect();
    this.subscribeAgentEvents();
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents();
      this.unsubscribeEvents = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    this.api.logger.info(`[vauxr-bridge] Connecting to vauxr: ${this.wsUrl}`);

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.api.logger.info("[vauxr-bridge] Connected to vauxr");
      this.reconnectMs = INITIAL_RECONNECT_MS;

      // Authenticate with channel token
      if (this.config.token) {
        this.send({ type: "channel.auth", token: this.config.token });
      }
    });

    ws.on("message", (data) => {
      try {
        const frame = JSON.parse(String(data)) as VauxrInboundFrame;
        this.handleFrame(frame);
      } catch (err) {
        this.api.logger.warn(`[vauxr-bridge] Failed to parse inbound frame: ${String(err)}`);
      }
    });

    ws.on("close", () => {
      this.api.logger.info("[vauxr-bridge] Disconnected from vauxr");
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.api.logger.warn(`[vauxr-bridge] WS error: ${String(err)}`);
      // 'close' event will fire after this — reconnect handled there
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.api.logger.info(
      `[vauxr-bridge] Reconnecting in ${this.reconnectMs}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
  }

  private handleFrame(frame: VauxrInboundFrame): void {
    switch (frame.type) {
      case "channel.transcript":
        if (frame.deviceId && frame.text) {
          void this.dispatchTranscript(frame.deviceId, frame.text);
        }
        break;
      case "channel.device_state":
        this.api.logger.info(
          `[vauxr-bridge] Device ${frame.deviceId ?? "unknown"}: ${frame.state ?? "unknown"}`,
        );
        break;
      case "channel.ready":
        this.api.logger.info("[vauxr-bridge] Channel authenticated");
        break;
      case "error":
        this.api.logger.warn(
          `[vauxr-bridge] Error from vauxr: ${frame.code ?? "UNKNOWN"} — ${frame.message ?? "no details"}`,
        );
        break;
      default:
        this.api.logger.warn(
          `[vauxr-bridge] Unknown frame type: ${String((frame as unknown as Record<string, unknown>).type)}`,
        );
    }
  }

  private async dispatchTranscript(deviceId: string, text: string): Promise<void> {
    const sessionKey = `vauxr:${deviceId}`;
    // Generate a protocol-level runId (sent to vauxr in response frames)
    const protocolRunId = crypto.randomUUID();
    this.api.logger.info(
      `[vauxr-bridge] Dispatching transcript for ${sessionKey} (runId=${protocolRunId}): "${text}"`,
    );

    try {
      const result = await this.api.runtime.subagent.run({
        sessionKey,
        message: text,
        idempotencyKey: protocolRunId,
        // Inject voice-formatting instructions so the model doesn't emit
        // markdown, emojis, or lists — responses are spoken aloud by TTS.
        // Uses the SDK's extraSystemPrompt field; omitted when not configured.
        ...(this.config.voiceSystemPrompt
          ? { extraSystemPrompt: this.config.voiceSystemPrompt }
          : {}),
      });
      this.activeRuns.set(result.runId, deviceId);
      this.runIdMap.set(result.runId, protocolRunId);
    } catch (err) {
      this.api.logger.warn(
        `[vauxr-bridge] Failed to dispatch transcript for ${sessionKey}: ${String(err)}`,
      );
      this.send({
        type: "channel.response.error",
        deviceId,
        runId: protocolRunId,
        message: String(err),
      });
    }
  }

  private subscribeAgentEvents(): void {
    this.unsubscribeEvents = this.api.runtime.events.onAgentEvent((event) => {
      const deviceId = this.activeRuns.get(event.runId);
      if (!deviceId) return; // Not a vauxr run

      const runId = this.runIdMap.get(event.runId) ?? event.runId;

      if (event.stream === "assistant") {
        // data.delta is the incremental chunk for streaming sessions;
        // data.text is the accumulated text (or full text for single-shot).
        // Prefer delta when present, fall back to text.
        const chunk =
          (typeof event.data["delta"] === "string" && event.data["delta"]) ||
          (typeof event.data["text"] === "string" && event.data["text"]) ||
          null;
        if (chunk) {
          this.send({
            type: "channel.response.delta",
            deviceId,
            runId,
            text: chunk,
          });
        }
      }

      // Clean up when run ends
      if (event.stream === "lifecycle" && event.data["phase"] === "end") {
        this.send({
          type: "channel.response.end",
          deviceId,
          runId,
        });
        this.activeRuns.delete(event.runId);
        this.runIdMap.delete(event.runId);
      }

      if (event.stream === "error") {
        this.api.logger.warn(
          `[vauxr-bridge] Agent error for device ${deviceId}: ${JSON.stringify(event.data)}`,
        );
        this.send({
          type: "channel.response.error",
          deviceId,
          runId,
          message: String(event.data["message"] ?? "Agent error"),
        });
        this.activeRuns.delete(event.runId);
        this.runIdMap.delete(event.runId);
      }
    });
  }

  private send(frame: VauxrOutboundFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}

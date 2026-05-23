import WebSocket from "ws";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/core";

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

interface ActiveVauxrTurn {
  deviceId: string;
  protocolRunId: string;
}

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

export class VauxrBridge {
  private ws: WebSocket | null = null;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  // Inflight turns keyed by deviceId. channel.turn.run doesn't surface an SDK
  // runId to the caller (unlike the old subagent.run path), so we correlate
  // emitted agent events back to the originating device by parsing the
  // normalized sessionKey (`agent:<agentId>:vauxr:<deviceId>`) carried on
  // each AgentEventPayload. One inflight turn per device at a time — voice
  // devices serialize naturally (TTS finishes before the next utterance).
  private activeRuns = new Map<string, ActiveVauxrTurn>(); // deviceId → turn
  // Per-device silent-reply sentinel state. "NO_REPLY" often arrives split
  // across streaming deltas (e.g. "NO" then "_REPLY"), so we buffer until
  // the accumulated text either matches the sentinel (suppress the whole
  // run) or diverges (flush and pass through).
  private sentinelBuffer = new Map<string, string>(); // deviceId → held delta text
  private sentinelMode = new Map<string, "passthrough" | "suppressed">();
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
    // Protocol-level runId sent to vauxr-ws in response frames so it can
    // correlate delta/end/error chunks back to this transcript.
    const protocolRunId = crypto.randomUUID();
    const turnId = `vauxr-${deviceId}-${Date.now()}`;
    this.api.logger.info(
      `[vauxr-bridge] Dispatching transcript for ${sessionKey} (runId=${protocolRunId}): "${text}"`,
    );

    // Register before dispatch so onAgentEvent can correlate any event the
    // agent runtime emits for this turn back to the originating device.
    this.activeRuns.set(deviceId, { deviceId, protocolRunId });

    const cfg = (this.api as { config?: OpenClawConfig }).config as OpenClawConfig;
    const storePath = this.api.runtime.channel.session.resolveStorePath(
      (cfg as { session?: { store?: string } }).session?.store,
    );

    // Minimal inbound context. Voice channels don't carry replies, media,
    // mentions, forwards, etc. — most MsgContext fields stay undefined.
    const ctxPayload = {
      Body: text,
      BodyForAgent: text,
      From: deviceId,
      SenderId: deviceId,
      SenderName: deviceId,
      SessionKey: sessionKey,
      Provider: "vauxr",
      Surface: "vauxr",
      Timestamp: Date.now(),
    };

    try {
      await this.api.runtime.channel.turn.run({
        channel: "vauxr",
        raw: { deviceId, text },
        adapter: {
          ingest: () => ({
            id: turnId,
            timestamp: Date.now(),
            rawText: text,
            raw: { deviceId, text },
          }),
          classify: () => ({ kind: "message", canStartAgentTurn: true }),
          resolveTurn: () => ({
            channel: "vauxr",
            routeSessionKey: sessionKey,
            storePath,
            // FinalizedMsgContext has ~80 optional fields; ours is a minimal
            // voice-channel subset. The kernel reads what it needs and ignores
            // the rest, so an unsafe cast is acceptable here.
            ctxPayload: ctxPayload as never,
            recordInboundSession:
              this.api.runtime.channel.session.recordInboundSession,
            runDispatch: async () => {
              // Outbound delivery flows through the existing onAgentEvent
              // delta tap (subscribeAgentEvents) for lowest TTS latency — see
              // spec decision D2. The reply dispatcher's `deliver` is a no-op
              // here; the dispatcher exists only to satisfy the channel-turn
              // contract and to give the dispatch-from-config pipeline a sink
              // to write into.
              const { dispatcher } =
                this.api.runtime.channel.reply.createReplyDispatcherWithTyping({
                  deliver: async () => undefined,
                });
              return await this.api.runtime.channel.reply.dispatchReplyFromConfig({
                ctx: ctxPayload as never,
                cfg,
                dispatcher,
              });
            },
          }),
        },
      });
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
    } finally {
      // channel.turn.run awaits the full turn (including the agent run inside
      // runDispatch), so by this point all events have fired and the turn is
      // done. Safe to clean up correlation state here.
      this.activeRuns.delete(deviceId);
      this.sentinelBuffer.delete(deviceId);
      this.sentinelMode.delete(deviceId);
    }
  }

  private subscribeAgentEvents(): void {
    this.unsubscribeEvents = this.api.runtime.events.onAgentEvent((event) => {
      // Correlate by sessionKey. channel.turn.run doesn't return an SDK runId
      // we could match against event.runId; instead the agent runtime tags
      // each emitted event with the normalized sessionKey, which for vauxr
      // turns is `agent:<agentId>:vauxr:<deviceId>`. Parse the deviceId out
      // and look up the active turn we registered in dispatchTranscript.
      const sk = event.sessionKey;
      if (!sk) return;
      const m = sk.match(/(?:^|:)vauxr:([^:]+)/);
      if (!m) return;
      const deviceId = m[1];
      const active = this.activeRuns.get(deviceId);
      if (!active) return;
      const runId = active.protocolRunId;

      if (event.stream === "assistant") {
        // Only forward the incremental delta. data.text is the running
        // accumulated reply — forwarding it as a delta would re-send
        // the entire reply on top of the deltas we've already sent,
        // duplicating it in TTS. The OpenClaw runtime emits at least
        // one final assistant event per run with `{ text }` only (no
        // `delta`); those carry no new content and must be dropped.
        const delta = event.data["delta"];
        if (typeof delta !== "string" || delta.length === 0) return;

        const mode = this.sentinelMode.get(deviceId);
        if (mode === "suppressed") return;
        if (mode === "passthrough") {
          this.send({ type: "channel.response.delta", deviceId, runId, text: delta });
          return;
        }

        // Buffering: hold deltas while the accumulated text could
        // still complete the silent-reply sentinel.
        const SENTINEL = "NO_REPLY";
        const buffered = (this.sentinelBuffer.get(deviceId) ?? "") + delta;
        const normalized = buffered.trim().toUpperCase();

        if (normalized === SENTINEL) {
          // Confirmed sentinel — suppress everything for this run.
          this.sentinelMode.set(deviceId, "suppressed");
          this.sentinelBuffer.delete(deviceId);
          return;
        }
        if (SENTINEL.startsWith(normalized)) {
          // Could still become the sentinel — keep holding.
          this.sentinelBuffer.set(deviceId, buffered);
          return;
        }
        // Diverged from sentinel — flush the held text and pass through
        // the rest of the run.
        this.sentinelMode.set(deviceId, "passthrough");
        this.sentinelBuffer.delete(deviceId);
        this.send({ type: "channel.response.delta", deviceId, runId, text: buffered });
      }

      // Signal end-of-turn to vauxr-ws so TTS finalizes. dispatchTranscript's
      // finally clears activeRuns once channel.turn.run returns; we don't
      // clean up here to avoid racing that path.
      if (event.stream === "lifecycle" && event.data["phase"] === "end") {
        this.send({
          type: "channel.response.end",
          deviceId,
          runId,
        });
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
      }
    });
  }

  private send(frame: VauxrOutboundFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }
}

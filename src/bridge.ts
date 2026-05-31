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
  private started = false;
  // Inflight turns keyed by deviceId. channel.turn.run doesn't surface an SDK
  // runId to the caller (unlike the old subagent.run path), so dispatch-time
  // bookkeeping is keyed by deviceId; we then latch onto the SDK runId on the
  // first event that arrives carrying a sessionKey (typically lifecycle.start)
  // and use that runId for all subsequent events from the same run. Most
  // event streams (assistant/tool/item) do NOT carry sessionKey — only the
  // lifecycle stream does — so runId-based correlation is load-bearing once
  // we've latched. One inflight turn per device at a time.
  private activeRuns = new Map<string, ActiveVauxrTurn>(); // deviceId → turn
  private runIdToTurn = new Map<string, ActiveVauxrTurn>(); // sdkRunId → turn
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
    if (this.started) return;
    this.started = true;
    this.connect();
    this.subscribeAgentEvents();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
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
    // Reset the backoff so a subsequent stop/start cycle (e.g. channel
    // aborts then restarts) begins reconnecting at INITIAL_RECONNECT_MS
    // instead of inheriting whatever escalated delay the previous run
    // had accumulated.
    this.reconnectMs = INITIAL_RECONNECT_MS;
  }

  private connect(): void {
    this.api.logger.debug?.(`[vauxr-bridge] Connecting to vauxr: ${this.wsUrl}`);

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.api.logger.debug?.("[vauxr-bridge] Connected to vauxr");
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
      this.api.logger.debug?.("[vauxr-bridge] Disconnected from vauxr");
      // Identity check: a stop() during the close-event async delay can be
      // followed by another start() that opens a fresh ws. If we cleared
      // `this.ws` blindly here we'd wipe the new socket's reference and
      // also fire a duplicate reconnect. Only act if we're still the
      // bridge's current ws.
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.started) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.api.logger.warn(`[vauxr-bridge] WS error: ${String(err)}`);
      // 'close' event will fire after this — reconnect handled there
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.api.logger.debug?.(
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
        this.api.logger.debug?.("[vauxr-bridge] Channel authenticated");
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
    const cfg = (this.api as { config?: OpenClawConfig }).config as OpenClawConfig;
    // Construct the sessionKey in the same form the old subagent.run path
    // ended up producing after openclaw's internal normalization
    // (`agent:<agentId>:vauxr:<deviceId>`). channel.turn.run does NOT apply
    // that same normalization to routeSessionKey — it stores under whatever
    // string we pass — so we have to build the full form ourselves to
    // preserve session continuity with prior turns / restarts.
    const agentId = resolveTargetAgentId(cfg);
    const sessionKey = `agent:${agentId}:vauxr:${deviceId}`;
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
      // OpenClaw 2026.5.28 renamed `runtime.channel.turn` to
      // `runtime.channel.inbound` (pure rename — same signature, same
      // ChannelInboundEventRunnerParams shape as the prior
      // RunChannelTurnParams). Earlier vauxr-openclaw releases that
      // referenced `.turn.run` will throw `Cannot read properties of
      // undefined (reading 'run')` on gateways 2026.5.28+.
      await this.api.runtime.channel.inbound.run({
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
      // done. Safe to clean up correlation state here. runIdToTurn entries
      // for this device are cleaned in the lifecycle.end branch of the event
      // handler — best-effort sweep here in case lifecycle.end never fired.
      this.activeRuns.delete(deviceId);
      this.sentinelBuffer.delete(deviceId);
      this.sentinelMode.delete(deviceId);
      for (const [rid, turn] of this.runIdToTurn) {
        if (turn.deviceId === deviceId) this.runIdToTurn.delete(rid);
      }
    }
  }

  private subscribeAgentEvents(): void {
    this.unsubscribeEvents = this.api.runtime.events.onAgentEvent((event) => {
      // Two-stage correlation:
      //   1. If the event carries a sessionKey (lifecycle events do, most
      //      others don't), parse the deviceId and look up the inflight turn
      //      we registered in dispatchTranscript. Cache the SDK runId so
      //      subsequent sessionKey-less events from the same run can be
      //      matched by runId alone.
      //   2. Otherwise, look up by event.runId — populated by step (1) for
      //      this turn's prior lifecycle event.
      // pi-embedded's first lifecycle.start carries sessionKey and arrives
      // well before any assistant deltas, so the latch is always primed
      // before delta events need to route.
      let active: ActiveVauxrTurn | undefined;
      const sk = event.sessionKey;
      if (sk) {
        const m = sk.match(/(?:^|:)vauxr:([^:]+)/);
        if (m) {
          active = this.activeRuns.get(m[1]);
          if (active) this.runIdToTurn.set(event.runId, active);
        }
      }
      if (!active) active = this.runIdToTurn.get(event.runId);
      if (!active) return;
      const { deviceId, protocolRunId: runId } = active;

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

/**
 * Resolve the agent id that vauxr turns should route to.
 *
 * Preference order:
 *   1. channels.vauxr.targetAgent (explicit operator config)
 *   2. plugins.entries.vauxr.config.targetAgent (alternate config slot)
 *   3. agents.list[].default === true
 *   4. agents.list[0].id (first declared agent)
 *   5. "default" sentinel (last resort — produces an obviously-wrong key the
 *      operator can spot in logs)
 */
function resolveTargetAgentId(cfg: OpenClawConfig): string {
  const raw = cfg as Record<string, unknown>;
  const fromChannels = (raw.channels as Record<string, unknown> | undefined)?.vauxr as
    | { targetAgent?: string }
    | undefined;
  if (fromChannels?.targetAgent) return fromChannels.targetAgent;
  const fromPlugins = (
    (raw.plugins as Record<string, unknown> | undefined)?.entries as
      | Record<string, unknown>
      | undefined
  )?.vauxr as { config?: { targetAgent?: string } } | undefined;
  if (fromPlugins?.config?.targetAgent) return fromPlugins.config.targetAgent;
  const agents = (raw.agents as { list?: Array<{ id?: string; default?: boolean }> } | undefined)
    ?.list;
  if (Array.isArray(agents)) {
    const defaultAgent = agents.find((a) => a.default && a.id);
    if (defaultAgent?.id) return defaultAgent.id;
    if (agents[0]?.id) return agents[0].id;
  }
  return "default";
}

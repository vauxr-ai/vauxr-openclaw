import { voiceContext } from "./voice_context.js";
import { RealtimeConversations } from "./realtime.js";
import { AsyncLocalStorage } from "node:async_hooks";
import WebSocket from "ws";
import { endpoints } from "./transport.js";
import type { VauxrAuth } from "./auth.js";
import type { OpenClawPluginApi, OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";

/** Vauxr protocol frames sent by vauxr to the channel plugin */
interface VauxrInboundFrame {
  type: "agent.realtime.request" | "agent.transcript" | "agent.device_state" | "agent.ready" | "error";
  requestId?: string;
  session?: string;
  operation?: string;
  payload?: Record<string, unknown>;
  deviceId?: string;
  text?: string;
  state?: string;
  name?: string;
  // Optional server-stored display metadata; never an identity or routing key.
  deviceDisplayName?: unknown;
  code?: string;
  message?: string;
  agentId?: string;
}

/** Vauxr protocol frames sent by the channel plugin to vauxr */
type VauxrOutboundFrame =
  | { type: "agent.realtime.result"; requestId: string; deviceId: string; result?: unknown; error?: string }
  | { type: "agent.auth"; token: string }
  | { type: "agent.response.delta"; deviceId: string; runId: string; text: string }
  | { type: "agent.response.end"; deviceId: string; runId: string }
  | { type: "agent.response.error"; deviceId: string; runId: string; message: string };

interface VauxrBridgeConfig {
  url: string;
  httpUrl?: string;
  strictTls?: boolean;
  voiceSystemPrompt?: string;
}

interface ActiveVauxrTurn {
  deviceId: string;
  protocolRunId: string;
  collect?: (text: string) => void;
  error?: boolean;
  outboundSequence: number;
  spokenPreambleItems?: Set<string>;
}

interface OutboundTurnContext {
  bridge: VauxrBridge;
  turn: ActiveVauxrTurn;
}

const outboundTurnContext = new AsyncLocalStorage<OutboundTurnContext>();

/** Deliver message-tool text only to the exact voice turn that invoked it. */
export function deliverCurrentTurnText(deviceId: string, text: string): string {
  const context = outboundTurnContext.getStore();
  if (!context) throw new Error("No active Vauxr voice turn for outbound text");
  return context.bridge.deliverTurnText(context.turn, deviceId, text);
}

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

export class VauxrBridge {
  private conversations?: RealtimeConversations;
  private realtimeRequests = new Map<string, Promise<unknown>>();
  private realtimeTails = new Map<string, Promise<unknown>>();
  private ws: WebSocket | null = null;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private started = false;
  // One inflight turn per device. SDK run IDs are registered by the
  // dispatch-specific onAgentRunStart callback, never inferred from a shared
  // session key: a retired dispatch can still emit events for that session.
  private activeRuns = new Map<string, ActiveVauxrTurn>(); // deviceId → turn
  private runIdToTurn = new Map<string, ActiveVauxrTurn>(); // sdkRunId → turn
  // Per-device silent-reply sentinel state. "NO_REPLY" often arrives split
  // across streaming deltas (e.g. "NO" then "_REPLY"), so we buffer until
  // the accumulated text either matches the sentinel (suppress the whole
  // run) or diverges (flush and pass through).
  private sentinelBuffer = new Map<string, string>(); // deviceId → held delta text
  private sentinelMode = new Map<string, "passthrough" | "suppressed">();
  private wsUrl: string;
  private authenticated = false;
  private generation = 0;
  #socketCredential?: string;

  constructor(
    private api: OpenClawPluginApi,
    private config: VauxrBridgeConfig,
    private auth?: VauxrAuth,
  ) {
    // Derive WS URL from HTTP base URL
    this.wsUrl = endpoints(config).wsUrl;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect();
    this.subscribeAgentEvents();
  }

  stop(): void {
    this.generation++;
    if (!this.started) return;
    this.started = false;
    this.retireTurns();
    this.auth?.disconnected();
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

  private retireTurns() {
    this.authenticated = false;
    this.activeRuns.clear(); this.runIdToTurn.clear();
    this.sentinelBuffer.clear(); this.sentinelMode.clear();
  }

  async refresh(): Promise<void> {
    const generation = this.generation;
    let next: string;
    try { next = await this.auth!.bearer(); }
    catch { this.stop(); return; }
    if (generation !== this.generation) return;
    if (this.started && next !== this.#socketCredential) this.stop();
    this.start();
    if (this.authenticated) this.auth?.connected();
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    let token: string;
    try { token = await this.auth!.bearer(); }
    catch { this.stop(); return; }
    if (!this.started || generation !== this.generation) return;
    this.#socketCredential = token;
    const ws = new WebSocket(this.wsUrl, { rejectUnauthorized: true, followRedirects: false, maxPayload: 1_048_576 });
    this.ws = ws;

    ws.on("open", () => {
      this.api.logger.debug?.("[vauxr-bridge] Connected to vauxr");
      this.reconnectMs = INITIAL_RECONNECT_MS;

      if (this.ws !== ws || !this.started) return;
      ws.send(JSON.stringify({ type: "agent.auth", token }));
    });

    ws.on("message", (data) => {
      if (this.ws !== ws || !this.started) return;
      try {
        const frame = JSON.parse(String(data)) as VauxrInboundFrame;
        this.handleFrame(frame);
      } catch (err) {
        this.api.logger.warn("[vauxr-bridge] Invalid inbound frame");
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
      this.retireTurns();
      this.auth?.disconnected();
      if (this.started) this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.api.logger.warn("[vauxr-bridge] WebSocket connection failed");
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
      void this.connect();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
  }

  private handleFrame(frame: VauxrInboundFrame): void {
    if (!frame || typeof frame !== "object") return;
    if (!this.authenticated && !["agent.ready", "error"].includes(frame.type)) return;
    switch (frame.type) {
      case "agent.realtime.request":
        void this.handleRealtime(frame);
        break;
      case "agent.transcript":
        if (frame.deviceId && frame.text && !this.activeRuns.has(frame.deviceId)) {
          // Never let a dispatch failure escape the ws message handler: an
          // unhandled rejection here takes down the whole gateway process.
          void this.dispatchTranscript(frame.deviceId, frame.text, frame.deviceDisplayName).catch(
            (err) => {
              this.api.logger.warn(
                "[vauxr-bridge] Transcript dispatch failed",
              );
            },
          );
        }
        break;
      case "agent.device_state":
        // Device metadata is untrusted; do not mirror payloads into logs.
        break;
      case "agent.ready":
        if (frame.agentId !== this.auth?.subject()) { this.stop(); return; }
        this.auth?.connected();
        if (this.auth?.status().state !== 'connected') { this.stop(); return; }
        this.authenticated = true;
        this.api.logger.debug?.("[vauxr-bridge] Agent authenticated");
        break;
      case "error":
        this.api.logger.warn("[vauxr-bridge] Server rejected Agent operation");
        if (frame.code === "UNAUTHORIZED") {
          this.stop();
          // The old socket may be retired by a just-committed rotation ACK.
          // Reconcile with the saved bearer before deciding this is revocation.
          void this.auth?.tick().catch(() => undefined);
        } else if (frame.code === "FORBIDDEN") this.stop();
        break;
      default:
        this.api.logger.warn(
          "[vauxr-bridge] Unknown frame type",
        );
    }
  }

  private async handleRealtime(frame: VauxrInboundFrame): Promise<void> {
    const { requestId, deviceId, session, operation, payload = {} } = frame;
    if (!requestId || !deviceId || !session || !/^[a-zA-Z0-9_-]{1,100}$/.test(session)) return;
    const key = `${deviceId}:${session}:${requestId}`;
    const socket = this.ws;
    try {
      let work = this.realtimeRequests.get(key);
      if (!work) {
        if (this.realtimeRequests.size >= 4096) throw new Error("Realtime request capacity reached; reconnect integration");
        const previous = this.realtimeTails.get(deviceId) ?? Promise.resolve();
        work = previous.catch(() => undefined).then(async () => {
          this.conversations ??= new RealtimeConversations(this.api.config, resolveTargetAgentId(this.api.config));
          if (operation === "bootstrap") return this.conversations.bootstrap(deviceId, session, frame.deviceDisplayName);
          if (operation === "release") return this.conversations.release(deviceId, session);
          this.conversations.scope(deviceId, session);
          if (operation === "record") return this.conversations.record(deviceId, session, payload.fragments as never, frame.deviceDisplayName);
          if (operation === "consult") {
            if (typeof payload.request !== "string" || payload.request.length > 32000) throw new Error("Invalid consultation");
            if (this.activeRuns.has(deviceId)) throw new Error("A backend turn is already running");
            let text = "";
            // This is a new consultation, not replay of prior turns. Full voice
            // history was recorded without dispatch. Only this request runs tools.
            await this.dispatchTranscript(deviceId,
              "Realtime voice consultation. Use the recorded conversation for context. " +
              "Resolve only the latest outstanding request, do not repeat completed actions. " +
              "Return results to the voice assistant; do not announce or send another reply.\n" + payload.request,
              frame.deviceDisplayName, delta => { text += delta; });
            return { text };
          }
          throw new Error("Unsupported realtime operation");
        });
        this.realtimeRequests.set(key, work);
        if (operation !== "consult") this.realtimeTails.set(deviceId, work);
      }
      const result = await work;
      if (this.ws === socket && this.authenticated) this.send({ type: "agent.realtime.result", requestId, deviceId, result });
    } catch {
      if (this.ws === socket && this.authenticated) this.send({ type: "agent.realtime.result", requestId, deviceId,
        error: "Backend realtime operation failed; an action may still be running. Check the backend before retrying." });
    }
  }

  private async dispatchTranscript(deviceId: string, text: string, deviceDisplayName?: unknown, collect?: (text: string) => void): Promise<void> {
    const cfg = (this.api as { config?: OpenClawConfig }).config as OpenClawConfig;
    // Construct the sessionKey in the same form the old subagent.run path
    // ended up producing after openclaw's internal normalization
    // (`agent:<agentId>:vauxr:<deviceId>`). channel.turn.run does NOT apply
    // that same normalization to routeSessionKey — it stores under whatever
    // string we pass — so we have to build the full form ourselves to
    // preserve session continuity with prior turns / restarts.
    const agentId = resolveTargetAgentId(cfg);
    const identity = voiceContext(agentId, deviceId, deviceDisplayName);
    const sessionKey = identity.SessionKey!;
    // Protocol-level runId sent to vauxr-ws in response frames so it can
    // correlate delta/end/error chunks back to this transcript.
    const protocolRunId = crypto.randomUUID();
    const turnId = `vauxr-${deviceId}-${Date.now()}`;
    this.api.logger.info(
      "[vauxr-bridge] Dispatching voice turn",
    );

    // Register before dispatch so onAgentEvent can correlate any event the
    // agent runtime emits for this turn back to the originating device.
    const activeTurn: ActiveVauxrTurn = { deviceId, protocolRunId, collect, outboundSequence: 0 };
    this.activeRuns.set(deviceId, activeTurn);

    // Minimal inbound context. Voice channels don't carry replies, media,
    // mentions, forwards, etc. — most MsgContext fields stay undefined.
    const ctxPayload = {
      Body: text,
      BodyForAgent: text,
      ...identity,
    } satisfies MsgContext;

    try {
      // OpenClaw 2026.8 requires an explicit agent id when resolving session
      // store paths (SessionStoreAgentIdRequiredError otherwise). Older
      // gateways ignore the extra options argument. Kept inside the try so a
      // future API change degrades to an error frame instead of a crash.
      const storePath = this.api.runtime.channel.session.resolveStorePath(
        (cfg as { session?: { store?: string } }).session?.store,
        { agentId },
      );

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
              // Ordinary assistant output flows through the onAgentEvent delta
              // tap for lowest TTS latency. Explicit message-tool text uses the
              // channel outbound adapter, bound below to this exact turn. The
              // reply dispatcher's `deliver` remains a no-op; it only satisfies
              // the channel-turn contract.
              const { dispatcher } =
                this.api.runtime.channel.reply.createReplyDispatcherWithTyping({
                  deliver: async () => undefined,
                });
              return await outboundTurnContext.run(
                { bridge: this, turn: activeTurn },
                () => this.api.runtime.channel.reply.dispatchReplyFromConfig({
                  ctx: ctxPayload as never,
                  cfg,
                  dispatcher,
                  // Voice replies are streamed to the originating device above.
                  // Do not inherit a harness/config default requiring message.send.
                  replyOptions: {
                    sourceReplyDeliveryMode: "automatic",
                    onAgentRunStart: (runId) => {
                      if (this.activeRuns.get(deviceId) === activeTurn) {
                        this.runIdToTurn.set(runId, activeTurn);
                      }
                    },
                  },
                }),
              );
            },
            // Required since OpenClaw 2026.8 for inbound adapters. Voice
            // turns are non-durable, so there is no adoption lifecycle. If
            // the kernel skips dispatch, tell the device instead of leaving
            // it waiting for TTS that will never arrive; correlation state
            // is swept by dispatchTranscript's finally block.
            runDispatchLifecycle: {
              turnAdoptionLifecycle: undefined,
              onDispatchSkipped: (reason: unknown) => {
                if (collect) { activeTurn.error = true; return; }
                this.api.logger.warn(
                  "[vauxr-bridge] Dispatch skipped",
                );
                this.send({
                  type: "agent.response.error",
                  deviceId,
                  runId: protocolRunId,
                  message: "Dispatch skipped",
                });
              },
            },
          }),
        },
      });
      if (collect && activeTurn.error) throw new Error("Backend consultation failed");
    } catch (err) {
      this.api.logger.warn(
        "[vauxr-bridge] Transcript dispatch failed",
      );
      if (collect) throw err;
      this.send({
        type: "agent.response.error",
        deviceId,
        runId: protocolRunId,
        message: "Transcript dispatch failed",
      });
    } finally {
      // channel.turn.run awaits the full turn (including the agent run inside
      // runDispatch), so by this point all events have fired and the turn is
      // done. Only this exact turn may clean up its correlation state; an
      // unresolved retired dispatch may finish after a replacement starts.
      if (this.activeRuns.get(deviceId) !== activeTurn) return;
      this.activeRuns.delete(deviceId);
      this.sentinelBuffer.delete(deviceId);
      this.sentinelMode.delete(deviceId);
      for (const [rid, turn] of this.runIdToTurn) {
        if (turn === activeTurn) this.runIdToTurn.delete(rid);
      }
    }
  }

  private subscribeAgentEvents(): void {
    this.unsubscribeEvents = this.api.runtime.events.onAgentEvent((event) => {
      // Only the dispatch that owns this SDK run can register it. Late
      // starts/events from a retired turn cannot latch onto its replacement.
      const active = this.runIdToTurn.get(event.runId);
      if (!active || this.activeRuns.get(active.deviceId) !== active) return;
      if (active.collect) {
        if (event.stream === "assistant" && typeof event.data["delta"] === "string") active.collect(event.data["delta"]);
        if (event.stream === "error") active.error = true;
        return;
      }
      const { deviceId, protocolRunId: runId } = active;

      // OpenClaw publishes native commentary/progress as completed preamble
      // items, not as assistant deltas or message-tool outbound text. Forward
      // the completed item once so partial update snapshots are not repeated
      // verbatim by TTS when the matching `end` event arrives.
      if (event.stream === "item"
          && event.data["kind"] === "preamble"
          && event.data["phase"] === "end") {
        const text = event.data["progressText"];
        if (typeof text !== "string" || text.length === 0) return;
        const itemId = event.data["itemId"];
        if (typeof itemId === "string" && itemId.length > 0) {
          active.spokenPreambleItems ??= new Set<string>();
          if (active.spokenPreambleItems.has(itemId)) return;
          active.spokenPreambleItems.add(itemId);
        }
        this.send({ type: "agent.response.delta", deviceId, runId, text });
        return;
      }

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
          this.send({ type: "agent.response.delta", deviceId, runId, text: delta });
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
        this.send({ type: "agent.response.delta", deviceId, runId, text: buffered });
      }

      // Signal end-of-turn to vauxr-ws so TTS finalizes. dispatchTranscript's
      // finally clears activeRuns once channel.turn.run returns; we don't
      // clean up here to avoid racing that path.
      if (event.stream === "lifecycle" && event.data["phase"] === "end") {
        this.send({
          type: "agent.response.end",
          deviceId,
          runId,
        });
      }

      if (event.stream === "error") {
        this.api.logger.warn(
          "[vauxr-bridge] Agent error",
        );
        this.send({
          type: "agent.response.error",
          deviceId,
          runId,
          message: "Agent error",
        });
      }
    });
  }

  deliverTurnText(turn: ActiveVauxrTurn, deviceId: string, text: string): string {
    if (!text || turn.collect || turn.deviceId !== deviceId
        || this.activeRuns.get(deviceId) !== turn
        || !this.authenticated || this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("Vauxr voice turn is no longer available for outbound text");
    }
    const messageId = `${turn.protocolRunId}:${++turn.outboundSequence}`;
    this.send({
      type: "agent.response.delta",
      deviceId,
      runId: turn.protocolRunId,
      text,
    });
    return messageId;
  }

  private send(frame: VauxrOutboundFrame): void {
    if ("runId" in frame && this.activeRuns.get(frame.deviceId)?.protocolRunId !== frame.runId) return;
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) {
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

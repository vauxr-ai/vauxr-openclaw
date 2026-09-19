import { voiceContext } from "./voice_context.js";
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getSessionEntry, upsertSessionEntry, resolveStorePath, recordSessionMetaFromInbound } from "openclaw/plugin-sdk/session-store-runtime";
// OpenClaw 2026.9.3 exports these runtime modules without declaration files.
// @ts-expect-error verified runtime export in pinned SDK
import { resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
// @ts-expect-error verified runtime export in pinned SDK
import { appendSessionTranscriptMessagesByIdentity, readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";

type Scope = { agentId: string; sessionKey: string; sessionId: string; storePath: string };
type Fragment = { id: string; role: "user" | "assistant"; text: string; delivered?: boolean };

/** Session writes never dispatch a prompt or execute an action. */
export class RealtimeConversations {
  private sessions = new Map<string, Scope>();
  constructor(private config: OpenClawConfig, private agentId: string) {}

  async bootstrap(deviceId: string, session: string, displayName?: unknown) {
    if (this.sessions.size >= 128) throw new Error("Too many realtime sessions; reconnect the integration");
    const ctx = voiceContext(this.agentId, deviceId, displayName);
    const sessionKey = ctx.SessionKey!;
    const storePath = resolveStorePath(this.config.session?.store, { agentId: this.agentId });
    let row = getSessionEntry({ storePath, sessionKey });
    if (!row?.sessionId) {
      await upsertSessionEntry({ storePath, sessionKey, entry: { sessionId: randomUUID(), updatedAt: Date.now() } });
      row = getSessionEntry({ storePath, sessionKey });
    }
    if (!row?.sessionId) throw new Error("Backend session could not be created");
    const scope = { agentId: this.agentId, sessionKey, sessionId: row.sessionId, storePath };
    await recordSessionMetaFromInbound({ storePath, sessionKey, ctx, createIfMissing: false });
    this.sessions.set(`${deviceId}:${session}`, scope);
    const instructions = await resolveRealtimeBootstrapContextInstructions({ config: this.config, ...scope });
    const entries = await readVisibleSessionTranscriptMessageEntries(scope);
    const messages: { role: string; content: string }[] = [];
    let budget = 12000;
    for (const entry of entries.slice(-24).reverse()) {
      const message = entry.message;
      if (!["user", "assistant"].includes(message?.role)) continue;
      const text = typeof message.content === "string" ? message.content :
        (message.content ?? []).filter((p: { type: string }) => p.type === "text")
          .map((p: { text: string }) => p.text).join(" ");
      if (!text) continue;
      const content = text.slice(-Math.min(2000, budget));
      if (!content) break;
      messages.unshift({ role: message.role, content });
      budget -= content.length;
      if (!budget) break;
    }
    return { instructions: instructions ?? "", messages, sessionId: scope.sessionId };
  }

  scope(deviceId: string, session: string) {
    const scope = this.sessions.get(`${deviceId}:${session}`);
    if (!scope || getSessionEntry(scope)?.sessionId !== scope.sessionId) {
      throw new Error("Backend session changed; restart realtime");
    }
    return scope;
  }

  /** Drop only this ephemeral realtime connection scope; transcript ownership persists. */
  release(deviceId: string, session: string) {
    this.sessions.delete(`${deviceId}:${session}`);
    return { released: true };
  }

  async record(deviceId: string, session: string, fragments: Fragment[], displayName?: unknown) {
    const scope = this.scope(deviceId, session);
    if (!Array.isArray(fragments) || fragments.length > 64) throw new Error("Invalid transcript batch");
    const messages = fragments.map(f => {
      if (!f || !/^[a-zA-Z0-9_-]{1,100}$/.test(f.id) || !["user", "assistant"].includes(f.role)
          || typeof f.text !== "string" || f.text.length > 16000) throw new Error("Invalid transcript fragment");
      // Playback cannot be proven after interruption/disconnect. Keep generated
      // text explicitly marked instead of claiming the full output was heard.
      const text = f.role === "assistant" && !f.delivered ? `[Voice output; delivery unconfirmed] ${f.text}` : f.text;
      return { eventId: `vauxr-${session}-${f.id}`, message: {
        role: f.role, content: [{ type: "text", text }], timestamp: Date.now(),
        idempotencyKey: `vauxr-${session}-${f.id}`,
        ...(f.role === "assistant" ? { api: "openai-responses", provider: "openai", model: "gpt-live-1", stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}),
      } };
    });
    await recordSessionMetaFromInbound({ ...scope,
      ctx: voiceContext(this.agentId, deviceId, displayName), createIfMissing: false });
    await appendSessionTranscriptMessagesByIdentity({ ...scope, config: this.config, messages });
    return { recorded: fragments.length };
  }
}

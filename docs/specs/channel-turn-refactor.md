# Spec: Refactor vauxr channel to use `channel.turn.run`

**Status:** Draft — design review
**Branch:** `feat/spec-channel-turn-refactor`

## Background

The vauxr WebSocket bridge currently dispatches inbound device transcripts to OpenClaw via `api.runtime.subagent.run(...)` (`src/bridge.ts:161`). That entry point routes through OpenClaw's `agentCommandFromIngress` → `agentCommandInternal`, which contains an unconditional "gap-fill" persistence path (in the bundled runtime: `agent-command-BQgTSh4F.js:935-936`):

```js
const transcriptPersistenceRunner = result.meta.executionTrace?.runner;
const embeddedAssistantGapFill =
  transcriptPersistenceRunner === "embedded" ||
  (transcriptPersistenceRunner === void 0 && Boolean(result.meta.finalAssistantVisibleText?.trim()));
if (transcriptPersistenceRunner === "cli" || embeddedAssistantGapFill) try {
  sessionEntry = await attemptExecutionRuntime.persistCliTurnTranscript({ ... });
```

For pi-embedded anthropic-messages runs (vauxr's default model), pi-embedded sets `runner === "embedded"` at `pi-embedded-CPEBK2iK.js:3652`, which fires the gap-fill even though pi-embedded's stream-time persistence (via `run-attempt-DValQTsj.js:443` → `appendSessionTranscriptMessage`) already wrote the assistant message. Result: every assistant turn appears **twice** in the session JSONL:

- **First copy** — `api: "anthropic-messages"`, real cost, has `responseId`, written by pi-embedded streaming.
- **Second copy** — `api: "cli"`, `cost.total: 0`, no `responseId`, written by the gap-fill ~300–400 ms later.

A dedup check in `attempt-execution-Bt2wFQmK.js:127` (`readTailAssistantTextFromSessionTranscript`) is intended to prevent this but only inspects the literal **last line** of the session file. An `openclaw.cache-ttl` custom entry written between the two writes (emitted per-attempt at `selection-61FIEezO.js:9200`, since `agents.defaults.contextPruning.mode === "cache-ttl"`) defeats the dedup.

Signal, telegram, and openclaw's built-in webchat **don't hit this** because they dispatch through `runChannelTurn` (exposed in the plugin SDK as `api.runtime.channel.turn.run`), which is a separate code path that doesn't include the gap-fill. Empirically verified by instrumenting the bundled runtime with a one-line `console.error` at the gap-fill condition: vauxr turns fire `agentCommandInternal`; a Signal turn from the same agent at the same time does **not** reach the same function.

The fix can live in two places: (a) upstream openclaw runtime (3-line condition change), or (b) vauxr-side, by switching to the channel-native code path. This spec covers (b) because the vauxr manifest already declares `"kind": "channel"` and `"channels": ["vauxr"]` — the current `subagent.run` shape is an architectural inconsistency that predates the channel-SDK surface being exposed for third-party plugins.

## Goal

Refactor `vauxr-openclaw` so the WebSocket bridge dispatches transcripts through `api.runtime.channel.turn.run(...)` with a vauxr-supplied adapter (`ingest` / `classify` / `resolveTurn`), and delivers assistant text back to vauxr-ws through a channel-native reply dispatcher rather than the current `onAgentEvent` delta tap. This eliminates the duplicate-write bug and aligns vauxr's implementation with what its plugin manifest already declares.

## Non-goals

- Adding pairing, DM allowlists, or setup wizards. Vauxr devices are trusted local hardware and `src/channel.ts` explicitly opts out of those surfaces.
- Changing the WebSocket protocol between vauxr-openclaw and vauxr-ws. The frame schemas (`channel.transcript`, `channel.response.delta`, `channel.response.end`, `channel.response.error`) stay byte-for-byte compatible.
- Changing the user-facing `channels.vauxr` config schema.
- Touching the REST tools layer (`src/tools.ts`, `src/api-client.ts`).
- Fixing the upstream openclaw bug. Worth filing separately; this spec does **not** require it to be resolved.

## Current architecture

| Concern | Today |
|---|---|
| Inbound dispatch | `bridge.ts:dispatchTranscript` → `api.runtime.subagent.run({ sessionKey: "vauxr:" + deviceId, message, idempotencyKey, extraSystemPrompt })` |
| Outbound delivery | `bridge.ts:subscribeAgentEvents` taps `api.runtime.events.onAgentEvent`, forwards `delta` events as `channel.response.delta` WS frames |
| End-of-turn | `event.stream === "lifecycle"` with `phase === "end"` → emit `channel.response.end` |
| Session key | `vauxr:<deviceId>` (becomes `agent:<agentId>:vauxr:<deviceId>` after openclaw's normalization) |
| Silent-reply sentinel (`NO_REPLY`) | Buffered in `bridge.ts:194-232` on the delta stream |
| Channel plugin config | `src/channel.ts` already calls `createChatChannelPlugin` with a real `base` (capabilities, config adapter, setup hooks, agentPrompt). `outbound` and `gateway.startAccount` are honest stubs (see comments in those blocks). |
| Voice system prompt | `index.ts:before_prompt_build` injects `voiceSystemPrompt` when `sessionKey.startsWith("vauxr:")` |

## Target architecture

```
WebSocket inbound frame
   │  channel.transcript {deviceId, text}
   ▼
bridge.ts handleFrame
   │
   ▼
api.runtime.channel.turn.run({
  raw: frame,
  adapter: {
    ingest:    (raw) => ({ id, timestamp, rawText, raw }),
    classify?: (input) => ({ canStartAgentTurn: true }),
    resolveTurn: (input, evClass, preflight) => ({
      channel: "vauxr",
      accountId: <fromConfig>,
      routeSessionKey: <per D1>,
      storePath,
      ctxPayload: { Body, BodyForAgent, From, SessionKey, Provider: "vauxr", Surface: "vauxr", ... },
      runDispatch: async (rd) => {
         const dispatcher = createReplyDispatcher({
           deliver: async (payload) => sendDelta(deviceId, runId, payload.text),
           beforeDeliver: <NO_REPLY sentinel per D3>,
           onIdle:  () => sendEnd(deviceId, runId),
           onError: (err) => sendError(deviceId, runId, err),
         });
         await dispatchReplyFromConfig({ ..., dispatcher });
      },
    }),
  },
});
```

The bridge stays the WebSocket-protocol owner (parse inbound frames, send outbound frames, manage reconnect). Everything *between* `channel.transcript` arriving and `channel.response.delta` going out gets handed to the channel SDK.

## Design decisions (open — to be resolved in this PR's review)

### D1. Session key strategy

- **Today:** `agent:<agentId>:vauxr:<deviceId>` per device.
- **Signal pattern:** `agent:<agentId>:main` (shared with all main-scope sources) or `agent:<agentId>:signal:direct:<peerId>` depending on `dmScope`.
- **Question:** Do vauxr devices share the main session with web/Signal/heartbeat (`agent:<agentId>:main`), or stay per-device?
- **Implication:** Per-device keeps voice context isolated; the `index.ts:before_prompt_build` prefix check (`sessionKey.startsWith("vauxr:")`) already keys off this. Sharing main lets the model see what was said in text + voice together. Per-device is closer to current behavior; sharing main is what Signal does and what's most consistent with the SDK's `buildAgentPeerSessionKey` pattern.
- **Proposal:** Stay per-device for now; revisit if explicit cross-surface continuity is desired.

### D2. Streaming model

- **Today:** Direct tap of `onAgentEvent` `delta` events. Lowest possible latency — vauxr-ws starts TTS as soon as openclaw emits a delta.
- **Signal/webchat pattern:** Reply dispatcher with `blockStreamingCoalesce: { minChars, idleMs }`. Signal defaults to `{ minChars: 1500, idleMs: 1000 }` — unacceptable for voice (3–5 s of dead air per turn).
- **Question:** Can the reply dispatcher be tuned tight enough (`minChars: 1, idleMs: ~50`) to match the current delta tap's latency, or do we keep the `onAgentEvent` tap inside the channel-turn adapter as a hybrid (channel.turn.run for routing + onAgentEvent tap for streaming)?
- **Proposal:** Try tight coalesce first; benchmark TTS-start latency. If regression > ~200 ms perceived, fall back to hybrid.

### D3. `NO_REPLY` sentinel

- **Today:** Buffer deltas in `bridge.ts:194-232` until accumulated text either confirms or diverges from `NO_REPLY`.
- **Question:** Port the sentinel buffer into the reply dispatcher's `beforeDeliver` hook (cleaner — dispatcher handles suppress/passthrough per payload), or into the outbound `deliver` callback (closer to current code, simpler port)?
- **Proposal:** `beforeDeliver`. The dispatcher's payload boundary aligns roughly with sentence boundaries, so the sentinel is fully assembled before first deliver in practice. May need `onCleanup`/`onIdle` to fire `channel.response.end` correctly when the whole turn is suppressed.

### D4. Gateway lifecycle

- **Today:** `vauxrPlugin.gateway.startAccount` is a stub that just awaits abort; the actual WebSocket lifecycle is managed in `index.ts:registerFull` guarded by a `globalThis.__vauxrBridgeStarted` flag (which is itself a workaround for `registerFull` being invoked from multiple subsystems).
- **Question:** Move WS lifecycle into `gateway.startAccount`? That cleanly drops the global-flag hack and makes vauxr lifecycle observable to openclaw the way Signal's is.
- **Proposal:** Yes — move it. Keep the migration scoped to lifecycle ownership; don't refactor the WS reconnect loop in the same PR.

### D5. Outbound delivery mode

- **Today:** stub `{ deliveryMode: "direct" }`.
- **Question:** Stay `direct`, or switch to `queued` so vauxr-ws backpressure / dropped connections surface to the framework's retry machinery?
- **Proposal:** Stay `direct`. Vauxr-ws is local LAN; queueing adds latency and complexity for marginal benefit. Reconnect-on-failure stays in the bridge.

## Migration plan

1. **This spec PR** — pure markdown. Decisions D1–D5 are resolved in review comments and locked into the spec.
2. **Impl PR** (single PR, depends on this spec being merged):
   - `src/channel.ts`: replace `outbound` stub with a real `attachedResults.sendText` that pushes via the bridge (or move outbound delivery into the bridge entirely, depending on D5).
   - `src/bridge.ts`:
     - Remove `dispatchTranscript`'s `subagent.run` call; replace with `api.runtime.channel.turn.run({ raw, adapter })`.
     - Remove `subscribeAgentEvents` / `onAgentEvent` tap (or keep as a hybrid streaming source per D2).
     - Build the adapter (ingest, resolveTurn, runDispatch).
     - Port `NO_REPLY` sentinel per D3.
   - `src/channel.ts:gateway.startAccount`: take over WS lifecycle per D4.
   - `index.ts`: drop `__vauxrBridgeStarted` global flag and the in-place bridge instantiation (move to `gateway.startAccount`).
3. **Verification** — run the live-reproduction protocol from the investigation: send 5 vauxr turns, confirm session JSONL has exactly one assistant write per turn; measure TTS-start latency vs. baseline.

## Risks

- **Voice latency regression (D2).** If the reply dispatcher's coalesce can't be tuned tight enough, voice gets choppy. *Mitigation:* hybrid streaming with `onAgentEvent` tap retained.
- **`NO_REPLY` sentinel mis-port (D3).** Currently load-bearing — vauxr would speak "no reply" aloud if it leaks. *Mitigation:* explicit test case in verification.
- **`before_prompt_build` sessionKey assumption (D1).** If D1 lands as "move to main session," the prefix check in `index.ts` no longer applies and voice system prompt injection silently breaks. *Mitigation:* update the check in the same commit as the sessionKey change, or stay per-device.
- **`runChannelTurn` is internal-leaning SDK surface.** Exposed in `PluginRuntimeChannel.turn.run` but may not have the same stability guarantees as `api.runtime.subagent.run`. *Mitigation:* pin the openclaw peer dep version in `package.json` and document the integration point.
- **`openclaw.cache-ttl` semantics unchanged.** Even after this refactor, the runtime still emits the per-attempt cache-ttl entry. We're not relying on the upstream dedup at all in the target architecture, so it's not a vauxr-side concern — but worth being explicit that this spec does not pretend to fix the upstream gap-fill bug.

## Acceptance criteria

- A vauxr-driven turn writes exactly **one** assistant message to `<session>.jsonl` (verified by `grep -c '"role":"assistant"' <session>.jsonl` against a fresh single-turn session — must equal 1).
- TTS-start latency on the device is within ~200 ms of pre-refactor behavior (subjective; benchmark protocol agreed during impl).
- `NO_REPLY` sentinel still suppresses output (verified by forcing the system prompt to elicit it; vauxr-ws receives no `channel.response.delta` frames and a clean `channel.response.end`).
- `before_prompt_build` voice system prompt injection still fires (verified by inspecting `finalPromptText` in the trajectory for `voiceSystemPrompt` content).
- Voice device shows "ready" / connected state in vauxr-ws UI (lifecycle continues to work).
- No regressions in REST tool calls (`api-client.ts` and `tools.ts` are untouched).

## Out of scope (referenced for completeness)

- The upstream openclaw runtime bug (gap-fill firing for `runner === "embedded"` in `agentCommandInternal`). Worth filing separately; this spec does not require it to be fixed.
- The `readTailAssistantTextFromSessionTranscript` fragility (only inspects last line; defeated by interleaved custom entries). Same — upstream concern.

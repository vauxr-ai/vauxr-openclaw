# Spec: Refactor vauxr channel to use `channel.turn.run`

**Status:** Decisions locked — ready for impl
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

Refactor `vauxr-openclaw` so the WebSocket bridge dispatches inbound transcripts through `api.runtime.channel.turn.run(...)` with a vauxr-supplied adapter, instead of `api.runtime.subagent.run(...)`. This single change eliminates the duplicate-write bug by routing around `agentCommandInternal`'s gap-fill. The existing `onAgentEvent` delta tap stays in place for outbound streaming (see D2 below); other channel-native conversions (NO_REPLY port, gateway lifecycle, outbound delivery mode) are explicitly **deferred** to follow-up PRs.

## Non-goals (preferred to avoid)

These are scoped out of the initial impl but **not absolute** — if any becomes architecturally necessary during impl, we'll raise it for discussion rather than work around it.

- Adding pairing, DM allowlists, or setup wizards. Vauxr devices are trusted local hardware and `src/channel.ts` explicitly opts out of those surfaces.
- Changing the WebSocket protocol between vauxr-openclaw and vauxr-ws. The frame schemas (`channel.transcript`, `channel.response.delta`, `channel.response.end`, `channel.response.error`) should stay compatible if at all possible — but a server-side change is fair game if `channel.turn.run`'s adapter contract genuinely requires inbound metadata vauxr doesn't currently supply.
- Changing the user-facing `channels.vauxr` config schema. Same caveat — preferred to avoid, but not ruled out if the channel SDK requires a config field (e.g. an explicit account identifier) the current schema lacks.
- Touching the REST tools layer (`src/tools.ts`, `src/api-client.ts`). No anticipated cause to change these.
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

## Design decisions

### D1. Session key strategy — **LOCKED: keep per-device**

`agent:<agentId>:vauxr:<deviceId>` stays. The `index.ts:before_prompt_build` prefix check (`sessionKey.startsWith("vauxr:")`) continues to work unchanged. Cross-surface continuity with main/Signal is explicitly **not** wanted at this stage. May be revisited later, but is not on the table for this refactor.

### D2. Streaming model — **LOCKED: keep onAgentEvent tap (hybrid)**

The bridge continues to subscribe to `onAgentEvent` and forward `delta` events as `channel.response.delta` WS frames. The reply dispatcher (whatever shape it ends up taking inside the `channel.turn.run` adapter's `runDispatch` callback) does **not** drive outbound delivery in this refactor — its `deliver` callback can be a no-op or a deduplication guard.

Rationale: the `onAgentEvent` tap is the lowest-latency option available and is currently load-bearing for voice TTS. Migrating to a tight-coalesce reply dispatcher would require benchmarking and risks audible latency regression; it is not necessary to fix the duplicate-write bug, which is purely about which entry-point the agent run is invoked through. We can revisit later if there's reason to.

### D3. `NO_REPLY` sentinel — **DEFERRED (out of scope for initial impl)**

Sentinel buffering stays exactly where it is today (`bridge.ts:194-232`, on the `onAgentEvent` delta stream). Per D2, that stream still drives outbound, so the existing logic continues to work unchanged. A future follow-up PR can port the sentinel to the reply dispatcher's `beforeDeliver` hook **if** D2 is ever revisited; otherwise no port is needed.

### D4. Gateway lifecycle — **DEFERRED (out of scope for initial impl)**

`vauxrPlugin.gateway.startAccount` stays a stub; WS lifecycle stays in `index.ts:registerFull` guarded by `globalThis.__vauxrBridgeStarted`. The `channel.turn.run` integration is orthogonal to where the WS connection is owned, so cleaning up the global-flag hack can land as an independent follow-up PR whenever it's convenient.

### D5. Outbound delivery mode — **DEFERRED (out of scope for initial impl)**

`outbound.base.deliveryMode: "direct"` stub stays. Initial impl does not exercise the outbound adapter at all (per D2, delivery is via the `onAgentEvent` tap, not via the reply dispatcher). Switching to `queued` or wiring a real outbound adapter is a follow-up consideration if/when the outbound path is migrated.

### Independence of D3-D5

D3, D4, and D5 are all independent of D1, D2, and each other:

- D3 only matters if D2 changes (sentinel only needs porting if outbound moves off the onAgentEvent stream).
- D4 (lifecycle ownership) doesn't touch any code involved in inbound dispatch.
- D5 (outbound mode) only matters if the outbound adapter is actually used (which D2 says it isn't).

So D3/D4/D5 can each land in their own follow-up PR without forcing a rewrite of the initial impl.

## Migration plan

1. **This spec PR** — pure markdown. Decisions D1, D2 locked. D3, D4, D5 deferred to follow-ups (explicitly out of scope).
2. **Impl PR** (single PR, depends on this spec being merged):
   - `src/bridge.ts:dispatchTranscript` — the only function that meaningfully changes.
     - Replace the `api.runtime.subagent.run({...})` call with `api.runtime.channel.turn.run({ raw, adapter })`.
     - Build a minimal adapter:
       - `ingest(raw)` — return `{ id, timestamp, rawText, raw }` from the WS `channel.transcript` frame.
       - `classify?(input)` — return `{ canStartAgentTurn: true }` (no commands/reactions/etc. on voice).
       - `resolveTurn(input)` — return the route (channel: `"vauxr"`, sessionKey: `agent:<agentId>:vauxr:<deviceId>` per D1, ctxPayload, accountId, storePath) plus a `runDispatch` callback that invokes the agent through the channel-native code path.
     - The `runDispatch` callback invokes the agent (via `dispatchReplyFromConfig` or equivalent SDK helper — exact entry-point to be confirmed during impl by reading what the kernel passes the adapter and what the SDK actually exposes to plugins). Its reply dispatcher's `deliver` is a **no-op** per D2 — outbound continues to flow through the existing `onAgentEvent` tap.
     - Preserve the existing `activeRuns` / `runIdMap` bookkeeping so the `onAgentEvent` tap can still correlate runs back to devices.
   - `src/bridge.ts:subscribeAgentEvents`, NO_REPLY sentinel buffer, lifecycle/error handling — **unchanged**.
   - `src/channel.ts` — **unchanged** (D3/D4/D5 stubs stay).
   - `index.ts` — **unchanged** (`registerFull` + `__vauxrBridgeStarted` flag stay).
   - Expected diff: bridge.ts only, ~50–100 LoC. No new files, no new SDK exports consumed beyond `api.runtime.channel.turn` and whatever `runDispatch` needs.
3. **Verification** — send a fresh vauxr turn, confirm `grep -c '"role":"assistant"' <session>.jsonl` equals 1 for that turn (not 2 like today). Confirm TTS continues to start within the same ballpark as before (subjective — voice latency is the load-bearing concern that justifies the hybrid streaming approach).
4. **Optional follow-up PRs** — any of:
   - D4: move WS lifecycle to `gateway.startAccount`, drop the global flag hack.
   - D5: reconsider outbound delivery mode if outbound ever moves off the onAgentEvent tap.
   - D3: only relevant if D2 is ever revisited.

## Risks

- **`runDispatch` callback shape may not be as clean as the spec assumes.** The plugin SDK exposes `api.runtime.channel.turn.run` but the exact contract the `runDispatch` callback needs to fulfil — what it must call, what params it receives, whether a no-op reply dispatcher is actually valid — needs to be confirmed by reading the bundled `kernel-5-rDHkvC.js:runChannelTurn` implementation more carefully during impl. *Mitigation:* the impl PR's first commit should be a working spike that just plumbs through a no-op turn and verifies the bug is fixed; bookkeeping/correlation can land in subsequent commits.
- **Run-ID correlation between `channel.turn.run` and `onAgentEvent`.** The current bridge maps the SDK runId returned by `subagent.run` to a device. With `channel.turn.run`, we need an equivalent way to know which `onAgentEvent` events belong to which inbound transcript. If the kernel doesn't surface a runId at all to the adapter, we may need to derive correlation a different way (e.g. by sessionKey, or by tapping a lifecycle event). *Mitigation:* identify the correlation mechanism early in impl and confirm bookkeeping still works before tearing out the existing path.
- **`runChannelTurn` is an internal-leaning SDK surface.** Exposed in `PluginRuntimeChannel.turn.run` but may not have the same stability guarantees as `api.runtime.subagent.run`. *Mitigation:* pin the openclaw peer-dep version in `package.json` and document the integration point with a comment pointing back to this spec.
- **`openclaw.cache-ttl` semantics unchanged.** The runtime still emits the per-attempt cache-ttl entry. We're not relying on the upstream dedup at all in the target architecture, so it's not a vauxr-side concern — but worth being explicit that this spec does not pretend to fix the upstream gap-fill bug.

## Acceptance criteria

- A vauxr-driven turn writes exactly **one** assistant message to `<session>.jsonl` (verified by `grep -c '"role":"assistant"' <session>.jsonl` against a fresh single-turn session — must equal 1, not 2).
- TTS-start latency is no worse than today. Since the `onAgentEvent` delta tap is preserved (D2), this should hold trivially — but worth confirming subjectively on a voice device before merging.
- `NO_REPLY` sentinel still suppresses output (preserved by D3 deferral — same code path as today).
- `before_prompt_build` voice system prompt injection still fires (preserved by D1 — sessionKey prefix unchanged).
- Voice device shows "ready" / connected state in vauxr-ws UI (preserved by D4 deferral — lifecycle ownership unchanged).
- No regressions in REST tool calls (`api-client.ts` and `tools.ts` are untouched).

## Out of scope (referenced for completeness)

- The upstream openclaw runtime bug (gap-fill firing for `runner === "embedded"` in `agentCommandInternal`). Worth filing separately; this spec does not require it to be fixed.
- The `readTailAssistantTextFromSessionTranscript` fragility (only inspects last line; defeated by interleaved custom entries). Same — upstream concern.

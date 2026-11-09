# Documentation coverage and quality review

Scope: plugin branch `docs/maintainer-review-20261109`, extending
`54f53f6137b93360f1f6f127cd65cd17e892a550`. Sole-writer continuation preserved the
unfinished comments and reviewed them before publication. This is documentation
coverage, not security certification or proof that every peer/hardware path works.

The four primary reading paths have equal standing in [README](../README.md).
One authoritative home per topic: tutorial owns guided learning, how-to owns tasks,
reference owns lookup, explanation owns cross-module reasoning. Older auth/title
pages keep their historical evidence pins; the maintainer review owns findings.

## Subsystem matrix

T = [tutorial](tutorial.md), H = [how-to](how-to.md), R = [reference](reference.md),
E = [explanation](explanation.md). Entries identify substantive coverage, not merely
links added. A dash means that reader form is not useful for that small component.
All first-party runtime TypeScript modules are accounted for below.

| Subsystem / source | Existing material sufficient for | Gap filled: T / H / R / E | Source contract coverage |
| --- | --- | --- | --- |
| Registration `index.ts`, `setup-entry.ts` | Review describes API ownership | Offline first build/checkpoint / installation linkage / config precedence and hook consent / discovery vs full registration | Side-effect-free registration and runtime owner; misplaced inherited comment moved to actual entry boundary. |
| Channel `src/channel.ts` | Setup policy comment explains sender expansion | Wiring fixture / agent, prompt and tool-policy change / account vs connectivity / channel-owned lifetime | Single integration account; configuration presence does not imply authentication. |
| Defaults `src/defaults.ts` | Prompt string itself | Live plain-speech checkpoint / missing-hook recovery / custom/default lookup / normal replies vs announcements | Shared policy and downstream follow-up marker. |
| Runtime `src/runtime.ts` | Review maps polling | Enrollment checkpoints / status-based recovery / commands and timing / independent HTTP/socket loops | Stop does not cancel awaited auth, serialized poll, bounded public command output. |
| Auth `src/auth.ts` | Auth lifecycle has save/ACK detail | Owner comparison / explicit re-pair vs cancel / states, units and private binding / one-time delivery reasoning | Public status, durable record, serialization, terminal latch, readiness and cancellation boundaries. Corrected pre-existing port comment: failed commit can already be published. |
| Store `src/secret-store.ts` | Existing SDK/privacy/durability evidence | POSIX prerequisites / private-state recovery / size and units / readable vs durable distinction | Cross-adapter per-file queue, missing vs corrupt state; existing atomic flush comments retained. |
| Transport `src/transport.ts` | Existing TLS instructions | Network prerequisites / certificate/address diagnosis / URL derivation, deadline, byte cap, status mapping / separate connectivity proofs | Bounded error, same-host/scheme, generic is not validation, empty success and no AbortSignal. |
| HTTP `src/api-client.ts` | README tool authority | Device-list checkpoint / physical pairing / projections, command inputs and capability lifetime / authority vs submission | Rotating bearer callback, projections, firmware capability secrecy, units, per-attempt proof/state recheck. |
| Tools `src/tools.ts` | README tool table | Distinguish normal reply from announcement / pairing procedure / schema and outcomes / server vs plugin authority | Submission not completion; credentials/capabilities excluded from results. Existing tool descriptions retain detailed per-action consent. |
| Bridge `src/bridge.ts` | Review has detailed wire ownership | Identity/delivery fixtures / silent device and uncertain action / frames, memoization and limits / output retirement vs cancellation | Refresh generations, deduplication promise ownership, non-consult tail, outbound receipt semantics, no offline replay. Existing event/sentinel ownership comments retained. |
| Realtime `src/realtime.ts` | Existing basic history comments | Offline history concept / inspect before retry / operation payloads, limits, idempotency / remembering vs doing | Bootstrap bounds including rebinding guard, stale backend session, fragment retry identity and delivery assertion. |
| Identity `src/voice_context.ts` | Historical friendly-title review | Identity checkpoint / route by ID / label validation and timestamp units / identity table | Unified API docstring: display does not change sender/history/policy. |
| Build/schema/CI | README build and package pins | Reproducible build / focused verification / manifest authority / compatibility vs evidence distinction | No executable edits; package, schema and publish workflow inspected. |
| Test/fixture support | Existing review test inventory and historical results | Explicit offline path and expected outputs / disposable state and exact-head gates / historical fixture limits / no hardware claims | Selected wiring, delivery, identity, auth, storage, scoped-tool and Realtime fixtures exercised; no new comment-mirroring tests. |

Source and caller evidence: all listed runtime modules inspected; bridge dispatch,
Realtime operation dispatcher and session writer followed together; setup policy and
runtime ownership checked against `test/plugin-wiring.test.mjs`; Realtime history
and consult checked against `test/realtime.test.mjs`. Existing review ledger retains
broader earlier source/peer inspection and precise limits. This continuation does
not claim a fresh line-by-line audit of every test, historical spec or server module.
Generated `dist`, dependencies/vendor, lockfile transitive audit, fixture JSON byte
audit, firmware and live services are excluded from source-comment expansion.

## Before / after examples

1. **Entry point:** before, an unfinished ownership docstring was attached inside
   `hasConversationAccess` to a local config variable. After, it documents the full
   entry definition; hook lookup remains ordinary code. This repairs placement
   without changing registration semantics.
2. **ProtectedStore:** before, the API comment promised retaining the old record on
   failure. After, it states that failure can follow publication, so readability
   cannot justify ACK. This matches atomic rename followed by strict fsync/readback.
3. **Transport:** before, request comment listed forbidden transport features only.
   After, it includes deadline, byte cap, empty-success behavior, lack of cancellation
   parameter and the fact `T` does not validate the server response.
4. **Realtime record:** before, fragment retry/delivery semantics were left in the
   implementation. After, its API docstring requires stable fragment IDs and explains
   `delivered` is a peer assertion, alongside the actual batch/text limits.
5. **Reader entry:** before, README started with a maintainer map and architecture
   link. After, the four goals lead to an offline-to-live learning path, recoverable
   tasks, lookup tables and a design explanation. Review evidence is supporting
   material, not the required route to learn or operate the plugin.

## Verification for this expansion

- `npm run build`: passed with pinned dependency installation already present.
- Focused Node fixtures with disposable `OPENCLAW_STATE_DIR`: 34 passed, zero failed
  or skipped (wiring, friendly display, bridge delivery, auth failures, scoped tools,
  secret store, Realtime).
- TypeScript AST-printer comparison of HEAD vs working tree with comments removed:
  identical across all 13 changed TypeScript files. This includes types/imports and
  executable statements, not only generated JavaScript. Raw scanner comparison was
  unsuitable because regex lexical context requires parsing; parser comparison used.
- `git diff --check`, local Markdown targets and heading anchors checked before push.
- No full local test suite/Playwright, live enrollment, owner UI, physical speech,
  OTA, deployment, runtime config changes or functional fixes. The tutorial's live
  steps are source-verified instructions, not an executed acceptance claim.
- Historical full-suite failures and peer mismatches remain in the review document;
  selected green fixtures do not supersede those limits. Mermaid source reviewed;
  GitHub rendering and viewer interactions remain unverified.

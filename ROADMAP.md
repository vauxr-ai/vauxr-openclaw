# vauxr-openclaw Roadmap

Plugin-only remaining work. Server items live in [vauxr/ROADMAP.md](https://github.com/vauxr-ai/vauxr/blob/develop/ROADMAP.md).

Features grouped by theme. No ordering assigned.

## Planned

### Channel SDK
- **NO_REPLY on the channel-native path** — deferred from [docs/specs/channel-turn-refactor.md](docs/specs/channel-turn-refactor.md); the sentinel still lives on the delta stream in `bridge.ts`.
- **Gateway lifecycle** — `gateway.startAccount` is a stub; WS ownership is a process-global flag in `index.ts`. Cleaning that up is independent of turn dispatch.
- **Outbound delivery mode** — deferred from the same spec; outbound TTS still taps `onAgentEvent` deltas rather than a channel-native deliver callback.

Pairing, `/pair`, DM allowlists, and per-device OpenClaw `/status` are out of scope (`src/channel.ts` opts out). Vauxr devices are trusted local hardware.

## Shipped

- Channel plugin + outbound relay WS to Vauxr
- `channel.turn.run` dispatch (replaces `subagent.run`)
- `voiceSystemPrompt` via `before_prompt_build`
- Tools: `vauxr_devices`, `vauxr_announce`, `vauxr_control`

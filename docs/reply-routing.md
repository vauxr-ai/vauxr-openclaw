# Voice reply routing

Incoming voice turns normally receive a final assistant reply. The bridge's
`dispatchTranscript` uses `runtime.channel.inbound.run` and
`dispatchReplyFromConfig`; `subscribeAgentEvents` forwards assistant output over
the Vauxr WebSocket. An ordinary reply does not need a device lookup, a
`message(action=send)` call, or `vauxr_announce`.

## Shared integration

- `src/reply-routing.ts` defines transport guidance separately from voice style.
- `src/channel.ts` exposes it through the supported channel-owned
  `agentPrompt.messageToolHints` adapter. OpenClaw selects this adapter for the
  current runtime channel; it does not depend on session history or custom style.
- `index.ts` also adds it on every `before_prompt_build`, after the configured
  voice prompt (including an empty prompt). This hook remains subject to
  OpenClaw's existing conversation-access consent. No permissions are changed.
- Explicit source channel metadata takes precedence over a session-key fallback.
  The fallback accepts `vauxr:<deviceId>` and
  `agent:<agentId>:vauxr:<deviceId>`, not unrelated embedded substrings or child
  session suffixes.
- The announcement tool description requires an explicit user request. Separate
  authorized outbound messages and announcements are not prohibited.

## Runtime evidence and limits

Inspected the locally available OpenClaw SDK declarations and bundled source:

- `ChannelAgentPromptAdapter.messageToolHints` accepts configuration/account
  context, but not the resolved per-turn delivery mode.
- `resolveChannelMessageToolHints` selects the current channel adapter.
- `buildMessagingSection` adds channel hints when the message tool is available
  in a full prompt. Minimal prompts and prompts without that tool may omit them;
  the consent-gated hook provides the additional per-turn path.
- `resolveSourceReplyDeliveryMode` supports both `automatic` and
  `message_tool_only`, including strict/requested overrides, room events, and
  `messages.visibleReplies` configuration. `buildMessagingSection` explicitly
  says finals are private in tool-only mode. This is real runtime policy, not
  necessarily stale model behavior.

The shared guidance therefore defers to the current-turn source-delivery policy;
it does not force automatic mode, reinterpret user text as runtime policy, or
change gateway configuration. A custom style prompt is preserved verbatim, so
contradictory custom text is still something the model must resolve.

Vauxr's outbound `sendText` currently returns a placeholder result, while the
bridge uses assistant event streaming and a no-op dispatcher sink. This change
**does not implement or validate end-to-end message-tool-only delivery**, nor
prove that event streaming respects every upstream private-final/suppression
policy. Making that mode fully functional requires separate bridge/outbound
transport work and runtime integration tests. Do not use announcements as a
fallback for an unavailable delivery route.

`npm test` builds TypeScript and runs focused Node regression tests, including
actual plugin registration with a mock API. The mock does not emulate host hook
consent enforcement. Prompt construction tests do not guarantee model behavior,
TTS delivery, or compliance across harnesses. Live validation needs a separately
authorized deployment/restart, then normal voice turns, reset/new sessions,
custom voice prompts, and explicitly requested announcements. No deployment,
restart, installed-extension edit, or live device send is part of this change.

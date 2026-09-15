# Friendly device conversation titles

This plugin change stacks on PR #37 and requires its commits `cbb97e0`,
`5c849db`, and `69794b3`. It does not change enrollment, credentials, device
identity, sender policy, session routing, or response correlation.

## Verified OpenClaw boundary

Inspected the installed OpenClaw **2026.9.3** package read-only and installed the
lockfile-pinned 2026.9.3 dependency inside this checkout. Its public
`plugin-sdk/reply-runtime` exports `MsgContext`, whose `ConversationLabel?: string`
is documented as the conversation label, distinct from the sender.
`docs/plugins/sdk-subpaths.md` documents the public SDK module surfaces.

The production path is `VauxrBridge.handleFrame` → `dispatchTranscript` →
`runtime.channel.inbound.run` → `recordInboundSession` → session origin metadata.
OpenClaw's `resolveConversationLabel` prefers `ConversationLabel`;
`deriveSessionOrigin` persists it in `delivery.origin.label`.
`resolveGatewaySessionDisplayName` uses that origin label for external sessions
when no explicit user label/displayName overrides it. Existing manual titles
keep their normal OpenClaw precedence. No guessed context properties or direct
session-store patches are used by the plugin.

Every accepted transcript sets only `ConversationLabel` from validated metadata.
`From`, `SenderId`, `SenderName`, `agent:<agentId>:vauxr:<deviceId>`, active-turn
maps and outbound response `deviceId` remain the stable ID. Names never key a
map, conversation, or response. A rename updates metadata on the next transcript
without replacing the session or history. There is no background title migration.

## Required separate server-owner change (not implemented here)

Read-only inspection covered server `16968a73b7610c917a9922d94d8c7ef187f7dda3`
(the pinned PR #37 contract) and `12c01ca8116f4759d5d01198b688ad7adf232398`
(the available hello/reconnect repair checkout). `ChannelServer.send_transcript`
in `src/channel_server.py` serializes this frame today:

```json
{"type":"channel.transcript","deviceId":"dev_<stable-id>","sessionKey":"vauxr:dev_<stable-id>","text":"hello"}
```

Neither inspected sender supplies a friendly title. No live traffic was accessed.
In the latter checkout, `_hello` registers the authenticated `ctx.device_id`
without a name. `device_registry.register` prefers its explicit `name` argument,
then the loaded per-device configuration’s `name`, then prior registry name,
then the stable ID. `_voice_start` and `_realtime_start` pass the raw message name
or stable ID, so the registry/API device name can override the stored name with
an untrusted label or generated ID. It is not a reliable authority for this fix.
`device_config.py` persists per-device `name` in `devices.json`; enrollment's
`display_name` is separate request metadata, not an automatic room-name authority.

The server owner must add this optional, backward-compatible field to **each**
`channel.transcript`, retaining all existing fields and authentication gates:

```json
{"type":"channel.transcript","deviceId":"dev_<stable-id>","sessionKey":"vauxr:dev_<stable-id>","text":"hello","deviceDisplayName":"Living Room"}
```

Contract:

- Resolve the current stored device configuration name by the authenticated
  stable device ID when constructing the transcript. Use the server's persisted
  per-device `name`, never raw hello/voice/realtime labels or name lookup.
- Repeat the current name on every transcript, including after reconnect and
  server/plugin restart. A committed rename takes effect on the next transcript.
- Send a trimmed nonempty string of at most 128 JavaScript UTF-16 code units.
  Omit it when no valid stored name exists. The plugin rejects nonstrings,
  whitespace-only values, overlength values and C0/C1 controls, zero-width/bidi
  controls in U+200B–200F/U+2028–202E/U+2060–206F, and U+FEFF.
- Missing/malformed metadata falls back to the stable ID on that turn, including
  clearing a previously learned origin label. This stateless rule avoids stale
  cached names after a removal or authority change. Raw legacy `name` is ignored.
- Duplicate stored names are allowed; authorization and routing still use IDs.
  Keep active-channel/scoped-authority checks and response listener IDs intact.
- Verify stored-name precedence over conflicting raw labels, removal, rename,
  reconnect/restart and duplicate-name separation in the server's own tests.

Until that server addition ships separately, old frames continue to work and
continue to show stable IDs. No server, firmware, installed extension, deployment
configuration, gateway, or live system was modified by this plugin repair.

## Deterministic verification

`test/friendly-display.test.mjs` exercises real loopback WebSocket frame parsing,
ready gating, the production bridge, public OpenClaw inbound runner and real
session persistence in disposable checkout-local state. Only the LLM reply is
stubbed. A test-only import probes the pinned gateway's actual display projection;
it is intentionally version-specific and is never used in production.

The test seeds existing stable-ID sessions/history, verifies title acquisition,
rename, reconnect, malformed/missing fallbacks, ignored raw names, unchanged
session/history/sender identity and protocol correlation. Simultaneous devices
with duplicate titles complete in reverse order to expose cross-routing.

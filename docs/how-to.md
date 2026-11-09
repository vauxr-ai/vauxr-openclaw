# How-to: connect, route and recover

These guides assume a built/installed plugin and authorized operator access.
For a first learning path use the [tutorial](tutorial.md); for exact fields use
[reference](reference.md). Preserve existing config and consistent private state
before changing an installation. Never attach credential files to support reports.

## Change the responding agent or voice prompt

1. Identify an existing ID in `agents.list`. Set `channels.vauxr.targetAgent` to
   that ID, not its display name. Prefer channel configuration: nested legacy
   plugin configuration has a documented routing mismatch.
2. Set `channels.vauxr.voiceSystemPrompt` if you need a custom spoken policy.
   Enable `plugins.entries.vauxr.hooks.allowConversationAccess` for prompt injection.
3. Use the normal OpenClaw configure/setup workflow when changing `alsoAllow`:
   setup mirrors that list into the target agent's `tools.toolsBySender` entry
   `channel:vauxr:*` and removes that entry from other agents. Merely hand-editing
   the channel list does not invoke that setup transformation.
4. Restart the gateway and speak a new turn. Expect the chosen agent's history
   and plain-speech policy. Other agents' unrelated tool policies are preserved.

If tools are missing, check both the selected agent and its effective per-sender
policy. `alsoAllow` needs a matching explicit target; do not broaden every agent's
permissions to troubleshoot one channel. If replies contain Markdown, check hook
consent and the custom prompt before changing the speech provider.

## Recover a silent device

1. Run `/vauxr status`. For `pending`, compare codes in the owner UI before the
   deadline. Terminal setup states need explicit `/vauxr pair`; `cancel` only
   cancels unfinished setup, not completed authority.
2. For `transport_error` or `disconnected`, verify the API and socket addresses,
   same hostname/scheme, network reachability and CA trust. Reconnect/backoff is
   automatic; never disable certificate verification. Endpoint changes require
   gateway restart.
3. For `storage_error`, repair the gateway owner's private state access/durability
   support. Do not delete the record as a generic reset: a one-time delivered
   credential may no longer be retrievable. See [storage evidence](auth-lifecycle.md).
4. For `connected`, verify the owner selected this integration as active, then use
   `vauxr_devices` to identify the intended stable ID and connection state. Test a
   new short question. Connected integration and connected device are separate facts.
5. If a backend action timed out, inspect its result before retrying. Disconnect
   retires spoken output but does not cancel tools. A fresh request can repeat an
   action that already completed.

Expected recovery is authenticated status **and** an observed reply, not just an
accepted HTTP command. Persistent multi-device failures or Realtime capacity
errors should be checked against [review findings](maintainer-review.md#findings-requiring-follow-up);
a socket reconnect does not clear bridge-lifetime Realtime request retention.

## Pair a physical device without exposing its credential

1. Ask the user to deliberately open the intended device's physical window.
2. Call `vauxr_pairing` with `action: list`; select the exact request/device identity.
3. Before **each** `initiate` and `approve`, obtain the user's identification of the
   device, exact locally heard four digits (including zeros), and confirmation the
   physical window remains open. Supply those facts with the request and device IDs.
4. Expect `initiated`, then `approved`. Check the device list afterward: approval
   lets the device redeem its own credential; it is not a connection receipt.

If the request expired or changed state, reopen the physical window and list again;
never recycle inferred confirmation. Browser/recovery enrollment is owner-only.
The current 64-hex device-ID validator disagrees with some server defaults; an
`Invalid enrollment v1 response` can be that known incompatibility, not user error.
Do not change runtime ID settings as a documentation workaround.

## Verify a documentation/comment change locally

From the repository root run `npm run build`, `git diff --check`, and the explicit
fixture paths relevant to your topic. Use disposable `OPENCLAW_STATE_DIR` for SDK
history fixtures to avoid host state-version interference. See README development
verification for optional real-server source gates. Do not bypass their exact-head
checks. Full local Playwright is not part of this plugin documentation workflow.

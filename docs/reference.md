# Configuration and API reference

This page describes the checked-in plugin, not all server APIs. The manifest
`openclaw.plugin.json` is the configuration-schema authority; tool schemas live in
`src/tools.ts`. Historical server fixture pins and execution limits are in
[README verification](../README.md#development-verification) and [review evidence](maintainer-review.md).

## Configuration lookup

Prefer `channels.vauxr`. Registration also accepts plugin config, nested `vauxr`
before flat fields; it does not merge these slots. Bridge agent selection does
not honor nested legacy `targetAgent` (known mismatch). All fields below are
preferences/addresses, never credential input.

| Field | Default / contract |
| --- | --- |
| `url` | Required for configured channel; HTTP(S) origin or WS(S) equivalent; socket path becomes `/agent`. No userinfo, query, fragment or custom path. |
| `httpUrl` | Derived from `url`; only port 8765 becomes 8080. Must match socket hostname and selected security scheme; ports can differ. |
| `strictTls` | `false`; when true requires HTTPS/WSS. HTTPS validates certificates even when false. |
| `targetAgent` | Bridge falls back to configured default agent, first agent, then `default`; explicit ID required with nonempty `alsoAllow`. |
| `alsoAllow` | Extra tool names mirrored by setup into selected agent's per-sender policy; not a server authority grant. |
| `voiceSystemPrompt` | Shared plain-speech default in `src/defaults.ts`; custom value preserved. Hook consent is separately required. |
| `otaPublicBase` | Optional public HTTP(S) origin for `/firmware/satellite1.bin`; must be reachable by device, not just gateway. Secure clients require HTTPS. |

Commands `/vauxr status`, `/vauxr pair`, `/vauxr cancel` require authentication and
`operator.admin`. Status returns a public state with optional matching code and
Unix-second deadline. [README recovery](../README.md#recovery-and-migration) is the
state/action lookup. Protected records are version 1, bound to both endpoints;
path derivation and durability are documented in [auth lifecycle](auth-lifecycle.md).

## Tool inputs and results

| Tool | Inputs / effects |
| --- | --- |
| `vauxr_devices` | Empty object; text list and projected `details.devices`, not raw server objects. |
| `vauxr_announce` | `device_id`, plain-speech `text`; submits server TTS announcement. |
| `vauxr_control` | `device_id`, `command`; volume finite 0–100 for `set_volume`, boolean `enabled` for `set_barge_in`; `mute`, `unmute`, `reboot` need no extra params. |
| `vauxr_control` OTA | `command: ota`; `firmware_filename` (existing `.bin`) and `url` mutually exclusive. Otherwise uses `otaPublicBase`. Filename route mints an internal same-origin capability, reported lifetime 1–120 seconds, never returned to caller. No firmware publication. |
| `vauxr_pairing` | `action: list` or `initiate`/`approve`; mutations require `request_id`, `device_id`, four-digit string `code`, `heard_from_device: true`, `physical_window_open: true` from current human confirmation. |

Control/announcement success acknowledges submission, not device completion.
Pairing rechecks request identity, state (`ready` for initiate, `initiated` for
approve) and deadline. Current validator requires request ID 32 lowercase hex and
device ID `dev_` + 64 lowercase hex; see the recorded server mismatch before
assuming this is a portable opaque-ID contract. Unknown device fields are dropped;
rendered strings are bounded/redacted. No playback-URL, owner-admin or credential
input/output tool exists.

## Socket and Realtime lookup

`agent.auth` precedes traffic. Only matching `agent.ready.agentId` and accepted auth
state admit requests. [Ownership explanation](explanation.md) distinguishes the
IDs. Standard input is `agent.transcript` with `deviceId`, `text`, optional
`deviceDisplayName`. Output `agent.response.delta/end/error` carries `deviceId`
and wire `runId`; delta has `text`, error has `message`. Display names are trimmed,
max 128 characters, with control/bidi/invisible characters rejected.

Realtime input `agent.realtime.request` carries `deviceId`, `requestId`, `session`,
`operation`, optional `payload`. Result `agent.realtime.result` echoes device and
request IDs with `result` or a bounded `error` (not raw exceptions).

| Operation | Payload / result / limits |
| --- | --- |
| `bootstrap` | Returns instructions, messages, backend `sessionId`; last 24 entries, max 2000 characters each and 12000 total. Max 128 bound scopes; guard also applies to rebinding. |
| `record` | `fragments`: max 64, each `{id,role,text,delivered?}`; ID 1–100 alphanumeric/underscore/hyphen, role user/assistant, text max 16000 characters; returns count. Undelivered assistant text marked unconfirmed. |
| `consult` | `request` string max 32000 characters; one backend turn, collected `{text}` rather than separate voice reply. Refuses an active turn for same device. |
| `release` | Deletes ephemeral scope, returns `{released:true}`; does not erase history. |

Session tokens use 1–100 alphanumeric/underscore/hyphen characters. Deduplication
key is device + session + request ID; successes and failures are memoized up to
4096 distinct keys per bridge lifetime, including across reconnect. Retrying a
key with a changed payload does not execute a new operation. Non-consult operations
serialize per device; consult is not appended to that serialization tail.

## Transport failures and units

`requestJson<T>` is an internal JSON transport, not runtime schema validation.
It has a 10-second total deadline, 1 MiB response cap, no redirect/cookie behavior
or AbortSignal argument. Empty success resolves undefined. Non-2xx maps 401 to
`re_pair_required`, 403 to `operation_denied`, 429 to `rate_limited`, redirects to
`redirect_refused`, others to `http_<status>`. Native failures are bounded codes;
`VauxrError.status` defaults to 0 when no HTTP status is mapped.

Enrollment/lifecycle deadlines are Unix seconds; context timestamps are epoch
milliseconds. Limits above measure JavaScript string characters, not UTF-8 bytes;
the transport response and protected-store (65536) caps measure bytes.

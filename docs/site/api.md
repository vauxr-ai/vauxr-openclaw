# OpenClaw plugin API reference

Implementation: `e0f6c103f904363da431f864c8b39712ee1dc329`. The plugin registers **no HTTP server or SSE endpoint**. It is an authenticated integration client of Vauxr's [HTTP API](/server/docs/api/) and [integration WebSocket](/server/docs/api-transports/#integration-websocket-agent).

## Connection and authentication

[Connect the plugin](connect.md) using owner-approved software enrollment. The plugin generates and retains request identity/secret; request, status, deliver and durable-save acknowledgement use `/api/integrations/v1/{action}`. The delivered integration credential is disabled until saved and acknowledged. It is not an owner token and cannot enroll browser devices or administer owner settings. Credential lifecycle uses `/api/lifecycle/v1/{action}`; see the [exact fields and states](/server/docs/api-http-auth/).

The client sends `Authorization: Bearer <integration-credential>` for allowed management HTTP operations and `agent.auth` over `/agent`. It consumes `agent.transcript` and realtime requests and emits correlated responses. See the [complete wire lifecycle](/server/docs/api-transports/), including timeout, cancellation, reconnect and errors. A connected integration still must be selected as the active agent for voice routing. Connection is not proof of a completed voice turn.

## Registered tools

All four tools are non-optional. Arguments are JSON objects. Successful results have `content: [{type:"text",text:string}]` and `details`. Failures propagate as tool errors; a successful command submission is not physical playback acknowledgement.

### vauxr_devices

Arguments `{}`. Uses `GET /api/devices`. Returns text device summaries plus `details: {devices: Device[]}`. Each row includes opaque `id`, display `name`, `state`, `lastSeen`, optional platform/version and public config. An empty result says no devices are connected. Discover IDs here; names are not authority.

### vauxr_announce

Required `device_id: string`, `text: string`. Uses `POST /api/devices/{device_id}/announce` with `{text}`. Success text confirms submission and `details: {}`. Keep text plain and concise. Errors include unknown/disconnected device, invalid text or unavailable synthesis; see [device HTTP contracts](/server/docs/api-http-control/).

Example: `{"device_id":"<device-id>","text":"The timer is ready."}`.

### vauxr_control

Required `device_id: string`, `command` from the following table. Optional fields are command-specific:

| command | Additional arguments | HTTP params |
| --- | --- | --- |
| set_volume | `volume: number`, 0–100 | `{volume}` |
| mute, unmute, reboot | None | No params |
| set_barge_in | `enabled: boolean`, required | `{enabled}` |
| ota | `url: string` or `firmware_filename: string` | `{url}` |

Calls `POST /api/devices/{device_id}/command` with `{command,params?}`. For OTA, `url` and `firmware_filename` are mutually exclusive. Filename matches `^[A-Za-z0-9._-]+\.bin$`; the client first mints a short-lived delivery URL using `POST /api/firmware-delivery/{filename}`. Otherwise URL falls back to configured `otaPublicBase`; if neither is available the tool errors. URL must be reachable by the device, not Docker DNS. No upload/publication capability is provided. Playback URLs are reserved by the server and unsupported. Success returns submission text and `details: {}`.

Example: `{"device_id":"<device-id>","command":"set_barge_in","enabled":false}`.

### vauxr_pairing

`action: "list"|"initiate"|"approve"` is required. List takes no other required arguments and uses `POST /api/enrollment/v1/list` with `{}`; only physical requests are exposed; statuses include challenge, ready, initiated, approved, consumed, denied, cancelled, failed, expired and stale. Result includes `details: {requests}` with request ID, device ID, display name, status and expiry.

Initiate and approve additionally require:

| Argument | Contract |
| --- | --- |
| request_id | 32 lowercase hex characters, exact request from list |
| device_id | `dev_` followed by 64 lowercase hex characters, exact user-confirmed device |
| code | Exactly four decimal digits including leading zeros, heard locally from that device |
| heard_from_device | Must be `true`, based on this attempt's explicit user confirmation |
| physical_window_open | Must be `true`, based on this attempt's explicit user confirmation |

Before **each** initiate or approve, obtain the user's intended device, locally heard digits and confirmation that its deliberate physical pairing window remains open. Discovery or a supplied boolean does not establish consent. Never fetch or speak the code from the server. The client checks the fresh request/device match, then sends `{request_id,code}` to `/api/enrollment/v1/initiate` or `/approve`. Details include returned status/device ID. Approval permits redemption; it does not prove connection. Re-list connected devices after enrollment. Browser enrollment, recovery and credential administration are intentionally unavailable through this tool.

## Coverage and verification

Source authority: [tool registrations](https://github.com/vauxr-ai/vauxr-openclaw/blob/e0f6c103f904363da431f864c8b39712ee1dc329/src/tools.ts), [HTTP client](https://github.com/vauxr-ai/vauxr-openclaw/blob/e0f6c103f904363da431f864c8b39712ee1dc329/src/api-client.ts), [enrollment/lifecycle](https://github.com/vauxr-ai/vauxr-openclaw/blob/e0f6c103f904363da431f864c8b39712ee1dc329/src/auth.ts), [stream consumer](https://github.com/vauxr-ai/vauxr-openclaw/blob/e0f6c103f904363da431f864c8b39712ee1dc329/src/bridge.ts), [realtime consumer](https://github.com/vauxr-ai/vauxr-openclaw/blob/e0f6c103f904363da431f864c8b39712ee1dc329/src/realtime.ts).

All four tool registrations and their HTTP mappings were source-checked. No plugin HTTP registrar exists. Wire fields are documented once in the server reference, checked against these consumers. Examples are illustrative placeholders, not live command, pairing or media executions. Generated dist and dependencies are excluded.

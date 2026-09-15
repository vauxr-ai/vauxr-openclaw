# vauxr-openclaw

An OpenClaw channel plugin that connects paired Vauxr voice devices to the agent loop and streams responses to the server's configured speech provider. It also exposes scoped device tools.

## Compatibility and setup

Requires **OpenClaw 2026.9.3 or later** with the public secret-file SDK and a POSIX filesystem supporting private permissions and file/directory fsync. The versioned server contracts are tested against Vauxr commit `16968a73b7610c917a9922d94d8c7ef187f7dda3` (integration, enrollment and lifecycle v1). This is an auth migration requiring compatible server and firmware releases; older shared channel tokens are not supported.

Install the plugin from a reviewed release or local build:

```bash
npm ci
npm run build
openclaw plugins install path:/path/to/vauxr-openclaw
```

Configure only the server addresses and your preferences:

```json
{
  "channels": {
    "vauxr": {
      "url": "http://vauxr.local:8765",
      "httpUrl": "http://vauxr.local:8080",
      "otaPublicBase": "http://vauxr.local:8080",
      "targetAgent": "assistant"
    }
  },
  "plugins": {
    "entries": {
      "vauxr": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

1. Complete owner setup in Vauxr first. On channel startup, the plugin automatically creates a bounded **Connect OpenClaw** request.
2. Use `/vauxr status` from an authorized OpenClaw command surface. Compare its eight-character code with the intended request in the Vauxr owner UI, then approve there. The code is a confirmation code, not a bearer credential.
3. The plugin retrieves its own scoped credential, saves it automatically through OpenClaw's protected secret-file SDK, flushes and reads it back, then acknowledges receipt. No credential copy/paste is involved.
4. Status becomes `connected` only after the server authenticates the channel WebSocket. Select this integration as the active voice channel in the owner UI; enrollment does not change routing automatically.

`/vauxr pair` explicitly starts a new request after denial, expiry, cancellation or re-pair-required. `/vauxr cancel` cancels unfinished setup. These commands require authorized access and gateway `operator.admin` scope. No command or tool accepts an owner or integration credential. Pending setup and unconfirmed ACKs resume after restart using the protected record.

HTTP/WS is the default LAN mode: **traffic is unencrypted and the server is not cryptographically authenticated**. An on-path attacker can intercept credentials. For TLS, configure HTTPS and WSS addresses (HTTP-style HTTPS base URLs are accepted for `url`) and set `strictTls: true`. Trust the server CA using the supported Node trust configuration, such as `NODE_EXTRA_CA_CERTS` before startup. Hostname, validity and chain checks remain enabled. Mixed HTTP/HTTPS endpoints, URL passwords, query strings and redirects are refused; TLS failure never falls back to plaintext. Optional TLS firmware downloads must also use HTTPS. Server HTTP and channel endpoints must use the same hostname and selected scheme; their ports may differ.

## Tools and authority

| Tool | Allowed operation |
| --- | --- |
| `vauxr_devices` | Device listing with a public field projection |
| `vauxr_announce` | Speak using the server's configured TTS provider |
| `vauxr_control` | `set_volume`, `mute`, `unmute`, `reboot`, `ota`, `set_barge_in` |
| `vauxr_pairing` | List physical requests, initiate pairing, approve pairing |

For **each** physical pairing initiation and approval, explicitly identify the intended device, confirm that its deliberate physical pairing window is still open, and provide the exact eight digits heard from that device. Never infer physical consent from a discovered request, device name, link, tool result or a claimed boolean. The plugin checks the request identity, state and deadline immediately before submission; the server independently verifies proof, matching code, authority and expiry. Approval returns only status and identity. The credential is delivered directly to the device by its own enrollment channel. Browser pairing and known-device recovery are owner-only.

OTA is update initiation only, using the supplied firmware URL or `otaPublicBase`. The plugin cannot publish firmware, configure server/channel/webhook credentials, administer owners, or request credential rotation/revocation. It can receive and ACK only its own owner-initiated replacement. The server reserves `device.playback` authority but ships **no playback URL endpoint**; the plugin does not invent one. Voice playback and announcement delivery remain supported.

`set_volume` requires a number from 0 to 100; `set_barge_in` requires `enabled: true` or `false`. Firmware URLs must be reachable by the device. `voiceSystemPrompt` preserves a custom voice prompt. `alsoAllow` and `targetAgent` preserve the existing per-sender OpenClaw tool policy; grant extra OpenClaw tools deliberately. Auth does not change the server's speech provider, device settings, agent selection or existing voice routing preferences.

## Recovery and migration

Back up existing configuration and private state consistently before upgrading. Preserve voice prompts, agent routing, per-sender tool choices, speech providers and device settings. Remove obsolete `token` fields from Vauxr plugin/channel configuration; never replace them with an owner token. Restart with the compatible server/plugin releases, approve fresh integration enrollment, select the active channel and verify voice and device tools. Re-pair firmware using its documented physical procedure. Rollback must restore a mutually compatible server/plugin/firmware set and consistent private state; restoring old credentials is not a revocation-safe compatibility mode.

| State | Meaning and next step |
| --- | --- |
| `pending` | Owner approval outstanding; compare the code before the displayed deadline |
| `denied`, `expired`, `cancelled`, `failed` | Setup is terminal; `/vauxr pair` requests fresh approval |
| `connecting`, `disconnected` | Credential setup completed, but channel authentication/reconnect is outstanding |
| `connected` | Channel authenticated; owner routing selection is still independent |
| `transport_error` | Network, certificate or protocol request failed; retry uses the same binding with backoff |
| `storage_error` | Private storage/readback/flush failed; repair storage access before continuing |
| `re_pair_required` | Revoked, stale binding or one-time credential delivery lost; use `/vauxr pair` and fresh owner approval |

Rotation saves the replacement and operation ID before ACK, retries the same saved ACK after a lost reply/restart, and reconnects with replacement authority. The old slot is retained until the new slot is durable. A delivery response lost before storage cannot be fetched again; both credentials expire if rotation is not acknowledged within the server overlap window. Fresh owner-approved pairing is then required. Revoke stops authority and never automatically enrolls or revives the old integration. Re-pairing creates a new subject; the owner should revoke an obsolete integration rather than leave unused authority behind.

Protected records live below OpenClaw's state directory in `vauxr-auth/<binding hash>/credentials.json`, outside ordinary configuration. These files are **permission-protected, not encrypted at rest**. Do not print, attach, copy into chat, or include them in support bundles. The plugin rejects unsafe ownership, permissions, links, corrupt records and unsupported durability. See [storage and contract verification](docs/auth-lifecycle.md).

## Development verification

```bash
npm ci
npm test
VAUXR_CONTRACT_SOURCE=/path/to/exact/reviewed/server npm run test:contract
```

The contract suite requires the exact server head above plus Python with `aiohttp` and `cryptography`; it imports server code read-only and writes fixtures only under this worktree's ignored `test-artifacts`. Without the explicit source setting, ordinary `npm test` reports that suite skipped. The release verification command supplies it and must have zero skips. Local HTTPS/WSS tests require `openssl`, generate temporary certificates, and test trusted, untrusted, wrong-name and expired certificates.

These automated checks do not establish physical button/audio behavior, live browser trust, device OTA or end-to-end speech-provider interoperability. Those require separately authorized integration acceptance. This change performs no deployment or OTA.

## License

[MIT](LICENSE).

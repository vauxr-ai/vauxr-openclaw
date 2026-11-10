# Connect OpenClaw to Vauxr

Enroll the plugin with owner approval, then choose it as a conversation route.
Complete [plugin installation](start.md) first. Have access to the Vauxr owner UI
and an authorized OpenClaw command surface with gateway `operator.admin` scope.

## 1. Configure addresses without credentials

Merge this into your existing OpenClaw configuration; do not replace unrelated
settings. Replace the host with your server and `assistant` with an existing
OpenClaw agent ID.

```json
{
  "channels": {
    "vauxr": {
      "url": "http://vauxr.local:8765",
      "httpUrl": "http://vauxr.local:8080",
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

These are supported channel keys. `url` is the channel base, not the portal URL;
`httpUrl` is the HTTP API base. Both must use the same hostname and selected
scheme; ports may differ. Keep an existing `voiceSystemPrompt` if you use one.
Optional `alsoAllow` grants additional OpenClaw tools and requires `targetAgent`;
do not add it just to establish a connection.

HTTP/WS is the default LAN mode: traffic is unencrypted and the server is not
cryptographically authenticated. For TLS, use HTTPS bases for both addresses and
set `strictTls: true`. Configure Node trust (for example `NODE_EXTRA_CA_CERTS`
before startup) for your CA. Certificate checks remain enabled; TLS failures do
not fall back to plaintext. Mixed schemes, URL passwords, queries and redirects
are refused.

Expected: OpenClaw accepts the configuration. No owner token, integration token
or legacy `token` field belongs here.

## 2. Approve the intended request

Start/restart the OpenClaw gateway through your normal service controls. Channel
startup automatically creates a bounded **Connect OpenClaw** request.

Run `/vauxr status` from the authorized command surface. Compare the eight-character
code with the intended request in the Vauxr owner UI, and approve that matching
request before its displayed deadline. The code is a confirmation code, not a
bearer credential. Do not approve an unrelated request because it appeared first.

Expected: the plugin retrieves its own scoped credential, saves it using OpenClaw's
protected secret-file SDK, flushes and reads it back, then acknowledges receipt.
You do not copy or paste the credential. Pending setup and unconfirmed
acknowledgements resume after restart using the protected record.

## 3. Verify the channel, then select it

Run `/vauxr status` again. `connected` means the server authenticated the channel
WebSocket, not merely that approval succeeded. Select the connected integration
as the desired agent in Vauxr. Enrollment does not change routing automatically.

Try a short harmless conversation through the selected interface. Check the
agent response separately from speech output. Keep the server's working speech
provider and device settings; enrollment does not configure them. See
[Vauxr routing concepts](/server/docs/concepts) if another agent answers.

## Recover without exposing credentials

| Status | Next step |
| --- | --- |
| `pending` | Compare the matching code and approve before expiry |
| `denied`, `expired`, `cancelled`, `failed` | Use `/vauxr pair` to request fresh owner approval |
| `connecting`, `disconnected` | Check endpoint reachability and channel authentication |
| `transport_error` | Check host, ports, trust and protocol; retries back off on the same binding |
| `storage_error` | Repair private storage ownership, permissions or durability before continuing |
| `re_pair_required` | Use `/vauxr pair` and fresh owner approval |
| `connected`, wrong assistant | Select the integration in Vauxr; connection and routing are independent |

`/vauxr cancel` cancels unfinished setup. These commands require authorized access
and `operator.admin`; none accepts a credential argument. Revocation stops the
integration rather than silently enrolling it again. Re-pairing creates a new
subject; the owner should revoke unused old integrations.

Protected records live below OpenClaw's state directory at
`vauxr-auth/<binding hash>/credentials.json`. They are permission-protected, not
encrypted at rest. Never print or attach these files to a support report.

This guide is checked against configuration metadata and enrollment source; it
does not claim a live gateway, browser or audio acceptance run. Return to
[the plugin overview](start.md) for prerequisites.

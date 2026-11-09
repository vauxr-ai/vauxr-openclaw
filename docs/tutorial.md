# Tutorial: first local success

Learn how a channel adapter separates configuration, authority and voice delivery.
This path starts offline, then offers a live checkpoint when you have an owner and
compatible server. Work from the repository root; do not use an installed extension
as your source checkout.

## Prepare a disposable workspace

You need Node/npm compatible with the lockfile, Git, and a POSIX filesystem.
The package pins OpenClaw 2026.9.4; a newer running gateway does not replace that
build dependency. Clone the reviewed repository and select the revision you intend
to learn from, then run:

```sh
npm ci
npm run build
node --test test/plugin-wiring.test.mjs
```

**Checkpoint:** TypeScript emits `dist`, and the wiring tests pass. The tests use
fake gateway APIs and prove registration does not create protected state or open
network connections. They are not an enrollment or audio test. If an import fails,
check `node_modules/openclaw/package.json` against the package pin and repeat
`npm ci`; do not patch the installed SDK to make the example pass.

## Follow one identity without a server

Open `src/voice_context.ts` beside `test/friendly-display.test.mjs`, then run:

```sh
node --test test/friendly-display.test.mjs test/bridge-delivery.test.mjs
```

Notice that a display name can change the conversation title but not `SenderId`
or `SessionKey`. In the delivery fixture, text belongs to an exact active turn:
late work cannot claim a replacement turn's output. **Checkpoint:** the named tests
pass, and you can distinguish a device ID, a history key and a wire run ID. The
[explanation](explanation.md) shows where each belongs.

## Connect a real integration (optional live stage)

Prerequisites: an authorized OpenClaw operator, a compatible Vauxr server and
owner UI, a paired device, reachable server addresses and private writable gateway
state. Read [README compatibility/setup](../README.md#compatibility-and-setup)
first, including its plaintext LAN transport limitation and TLS alternative.
Historical fixture pins are not a guarantee that every current server is compatible;
check [known mismatches](maintainer-review.md#findings-requiring-follow-up).

1. Build and install with the README commands. Use the README configuration example
   with your actual addresses and an existing agent ID; never paste credentials.
2. Start/restart the gateway through its normal operator workflow. Run `/vauxr status`
   in an authorized command surface. Compare its code and deadline with **Connect
   OpenClaw** in the owner UI before approving.
3. Wait for `/vauxr status` to say `connected`. **Checkpoint:** this proves the
   socket authenticated, not that a device routes to this integration.
4. Select this integration as the active voice channel in the owner UI. Speak a
   short question on the paired device. **Checkpoint:** one reply is heard and its
   history belongs to the selected agent/device, not to a friendly-name key.

If approval expires, use `/vauxr pair` for a fresh request; if status is connected
but silent, follow the routing diagnosis in [how-to](how-to.md#recover-a-silent-device).
Do not use `vauxr_announce` to manufacture a successful normal voice reply.

The offline commands are automated fixture checks. This documentation update did
not execute installation, owner approval or physical speech; those checkpoints
must be observed in your own authorized environment.

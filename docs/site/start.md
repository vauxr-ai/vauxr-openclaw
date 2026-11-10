# Bring your OpenClaw agent to Vauxr

The Vauxr plugin connects your existing OpenClaw agent to Vauxr conversations and
lets it use scoped device tools. Vauxr owns the conversation interface and speech
services; OpenClaw owns the agent loop. Installing the plugin does not select it
as Vauxr's default assistant.

## What you need

- A running Vauxr server with owner setup complete. New to it? Start with
  [Vauxr](/server/docs/start).
- OpenClaw 2026.9.4 or later, matching the checked-in plugin compatibility metadata.
- A POSIX filesystem with private permissions and file/directory fsync for the
  plugin's protected credential storage.
- Network access from OpenClaw to both Vauxr's HTTP and channel ports.

## Install a reviewed build

From a reviewed `vauxr-openclaw` source checkout, with Node.js/npm available:

```sh
npm ci
npm run build
openclaw plugins install path:/absolute/path/to/vauxr-openclaw
```

Replace the absolute path with your checkout. Expected: the build succeeds and
OpenClaw registers the `vauxr` channel plugin. These instructions describe the
source-build path, not a claim of a published package version or a live installation.

Continue with [Connect OpenClaw](connect.md) to configure addresses, compare the
owner approval code and verify the authenticated channel. Keep existing OpenClaw
agent and tool settings when adding the new channel.

## Understand the success checkpoint

An installed plugin is not yet enrolled. An approved enrollment is not yet an
authenticated WebSocket. A connected channel is not yet the selected route.
Check those stages in order before testing conversation audio. A successful tool
request likewise does not prove audible playback.

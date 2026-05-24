# vauxr-openclaw

An OpenClaw channel plugin that bridges Vauxr voice devices into the OpenClaw agent loop. It connects to [Vauxr](https://github.com/vauxr-ai/vauxr) over WebSocket, dispatches inbound transcripts to the agent, and streams response deltas back for TTS playback.

It also registers three agent tools for direct device control from any session.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## How it works

### Channel Plugin Bridge (recommended)

```
Vauxr  <──WS (Vauxr protocol)──>  vauxr-openclaw plugin  <──>  OpenClaw agent loop
```

- The plugin opens an outbound WS connection to Vauxr on startup
- Inbound transcripts from devices are dispatched into the agent loop as `vauxr:{device_id}` sessions
- Agent response deltas stream back to Vauxr in real time for TTS playback
- A `before_prompt_build` hook injects a voice-optimized system prompt for all vauxr sessions

### Fallback: Direct Operator WS

```
Vauxr  <──WS (OpenClaw protocol)──>  OpenClaw gateway
```

If installing the plugin is undesirable, Vauxr can connect directly to the OpenClaw gateway as an operator. This still works but is limited:

- No voice system prompt injection
- No session detection for vauxr-specific behavior
- No plugin-side control over prompt or session routing

To use fallback mode, configure Vauxr with `OPENCLAW_URL` and `OPENCLAW_TOKEN` environment variables and do not install this plugin.

---

## Tools

| Tool | What it does |
|---|---|
| `vauxr_devices` | Lists all Vauxr devices connected to Vauxr, with their IDs, names, and connection state |
| `vauxr_announce` | Synthesizes text via Piper TTS and plays it through a device's speaker |
| `vauxr_control` | Sends a control command to a device (`set_volume`, `mute`, `unmute`, `reboot`) |

These tools use the Vauxr REST API and work in any session, not just vauxr voice sessions.

---

## Requirements

- OpenClaw gateway
- [Vauxr](https://github.com/vauxr-ai/vauxr) running and reachable
- At least one paired Vauxr device connected to Vauxr

---

## Installation

Install from ClawHub 🦞

```bash
openclaw plugins install clawhub:@vauxr/openclaw
```

Or install from the repo directly:

```bash
openclaw plugins install path:/path/to/vauxr-openclaw
```

Then configure in your OpenClaw config:

```json
{
  "channels": {
    "vauxr": {
      "url": "http://vauxr:8765",
      "token": "your-channel-token",
      "voiceSystemPrompt": "You are responding to a voice device. Use plain speech only — no emojis, no markdown, no code blocks. Keep replies concise."
    }
  },
  "plugins": {
    "entries": {
      "vauxr": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true
        }
      }
    }
  }
}
```

- `url` — Vauxr base URL (HTTP)
- `token` — channel token generated in the Vauxr web client
- `voiceSystemPrompt` — optional, appended to the system prompt for all vauxr sessions
- `alsoAllow` — optional, extra tools to grant vauxr-originated agent runs (see below)
- `targetAgent` — required if `alsoAllow` is set; the id of the agent that handles vauxr sessions

The `allowPromptInjection` hook permission is required for the voice system prompt to take effect.

### Granting broader tools to vauxr sessions

OpenClaw's runtime treats the internal `webchat` channel more permissively than third-party channels: tools like `gateway` and `nodes` are stripped from vauxr-originated runs even when the agent's profile would otherwise allow them. To restore those tools on vauxr sessions, set `alsoAllow` and `targetAgent`:

```json
{
  "channels": {
    "vauxr": {
      "url": "http://vauxr:8765",
      "token": "your-channel-token",
      "alsoAllow": ["gateway", "nodes"],
      "targetAgent": "nova-cloud"
    }
  }
}
```

On configure, the plugin writes a `channel:vauxr:*` entry into `agents.list[id=targetAgent].tools.toolsBySender`. The expansion is scoped to vauxr-originated runs only — other channels are unaffected. Be deliberate about what you grant: `gateway` lets the model restart OpenClaw, `nodes` lets it invoke commands on connected hardware nodes.

---

## Usage

Once installed, the plugin connects to Vauxr automatically. Voice turns from any device are routed through the plugin into the agent loop, and responses stream back for TTS playback.

The agent tools are available in all sessions:

**Announce something:**
> "Announce through the living room speaker that dinner is ready."

**Device control:**
> "Mute the bedroom speaker."
> "Turn the volume up on the kitchen device."

---

## Architecture

```
Vauxr device (mic)
    │
    │  voice.start / audio / voice.end
    ▼
Vauxr (STT: Whisper)
    │
    │  channel.transcript (WS)
    ▼
vauxr-openclaw plugin
    │
    │  subagent.run(sessionKey: "vauxr:{device_id}")
    ▼
OpenClaw agent loop
    │
    │  agent event deltas
    ▼
vauxr-openclaw plugin
    │
    │  channel.response.delta (WS)
    ▼
Vauxr (TTS: Piper)
    │
    │  0x02 audio frames
    ▼
Vauxr device (speaker)
```

---

## License

Vauxr OpenClaw is licensed under the [MIT License](LICENSE).


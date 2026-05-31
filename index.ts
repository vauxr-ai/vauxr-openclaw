import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { vauxrPlugin } from "./src/channel.js";
import { VauxrAPIClient } from "./src/api-client.js";
import { registerTools } from "./src/tools.js";
import { VauxrBridge } from "./src/bridge.js";
import { DEFAULT_VOICE_SYSTEM_PROMPT } from "./src/defaults.js";

interface VauxrConfig {
  url: string;
  httpUrl?: string;
  token?: string;
  voiceSystemPrompt?: string;
}

function resolveConfig(api: OpenClawPluginApi): VauxrConfig {
  if (api.pluginConfig && typeof api.pluginConfig === "object" && "url" in api.pluginConfig) {
    return api.pluginConfig as unknown as VauxrConfig;
  }
  const cfg = api.config as Record<string, unknown>;
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return (channels?.vauxr ?? {}) as VauxrConfig;
}

const entry = defineChannelPluginEntry({
  id: "vauxr",
  name: "Vauxr",
  description: "Vauxr voice device channel plugin for OpenClaw",
  plugin: vauxrPlugin,
  registerFull(api) {
    const config = resolveConfig(api);

    // REST tools — use explicit httpUrl if set, otherwise derive from ws url
    // (vauxr WS is on :8765, HTTP API is on :8080)
    const httpBase = config.httpUrl ?? (config.url ? config.url.replace(/:8765(\/?$)/, ":8080") : "");

    if (!httpBase) {
      // config.url not available yet (early registration) — skip bridge/tools
      return;
    }

    const client = new VauxrAPIClient(httpBase, config.token ?? "");
    registerTools(api, client);

    // Construct the WS bridge but DO NOT start it here. `registerFull` is
    // invoked from introspection paths too (e.g. `openclaw doctor`), and
    // starting the bridge here would open a live WebSocket to vauxr during
    // diagnostics. The bridge is started later by `gateway.startAccount`
    // (see channel.ts), which only fires when the gateway is actually
    // bringing the channel up for runtime use. The globalThis stash bridges
    // the two scopes because `startAccount` doesn't have access to `api`.
    //
    // The single-bridge guard remains here so multiple `registerFull`
    // invocations in the same process don't reconstruct the bridge — they'd
    // contend for the single active channel slot in vauxr otherwise.
    const g = globalThis as { __vauxrBridge?: VauxrBridge };
    if (!g.__vauxrBridge) {
      g.__vauxrBridge = new VauxrBridge(api, config);
    }

    // Voice system prompt injection for vauxr sessions. Match both the bare
    // form (`vauxr:<deviceId>`) used by the old subagent.run path and the
    // fully-prefixed form (`agent:<agentId>:vauxr:<deviceId>`) used by the
    // current channel.turn.run path. Either form means it's a vauxr turn.
    api.on("before_prompt_build", (_event, ctx) => {
      if (ctx.sessionKey && /(?:^|:)vauxr:/.test(ctx.sessionKey)) {
        return {
          appendSystemContext: config.voiceSystemPrompt ?? DEFAULT_VOICE_SYSTEM_PROMPT,
        };
      }
      return undefined;
    });
  },
});

export default entry;

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

    // WS bridge to vauxr — guard against double-registration.
    // OpenClaw invokes registerFull from multiple subsystems in the same
    // process; without this flag, both bridges would contend for the
    // single active channel slot in vauxr and flap continuously.
    const g = globalThis as { __vauxrBridgeStarted?: boolean };
    if (!g.__vauxrBridgeStarted) {
      g.__vauxrBridgeStarted = true;
      const bridge = new VauxrBridge(api, config);
      bridge.start();
    }

    // Voice system prompt injection for vauxr sessions
    api.on("before_prompt_build", (_event, ctx) => {
      if (ctx.sessionKey?.startsWith("vauxr:")) {
        return {
          appendSystemContext: config.voiceSystemPrompt ?? DEFAULT_VOICE_SYSTEM_PROMPT,
        };
      }
      return undefined;
    });
  },
});

export default entry;

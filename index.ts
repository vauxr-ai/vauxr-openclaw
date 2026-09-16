import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { vauxrPlugin } from "./src/channel.js";
import { VauxrAPIClient } from "./src/api-client.js";
import { registerTools } from "./src/tools.js";
import { VauxrRuntime } from "./src/runtime.js";
import { endpoints } from "./src/transport.js";
import { DEFAULT_VOICE_SYSTEM_PROMPT } from "./src/defaults.js";

interface VauxrConfig {
  url: string;
  httpUrl?: string;
  strictTls?: boolean;
  voiceSystemPrompt?: string;
  otaPublicBase?: string;
}

function hasConversationAccess(api: OpenClawPluginApi): boolean {
  const cfg = api.config as Record<string, unknown>;
  const plugins = cfg.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const entry = entries?.vauxr as Record<string, unknown> | undefined;
  const hooks = entry?.hooks as Record<string, unknown> | undefined;
  return hooks?.allowConversationAccess === true;
}

function resolveConfig(api: OpenClawPluginApi): VauxrConfig {
  const cfg = api.config as Record<string, unknown>;
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (channels?.vauxr) return channels.vauxr as VauxrConfig;
  const config = api.pluginConfig as VauxrConfig & { vauxr?: VauxrConfig } | undefined;
  return config?.vauxr ?? config ?? {} as VauxrConfig;
}

const entry = defineChannelPluginEntry({
  id: "vauxr",
  name: "Vauxr",
  description: "Vauxr voice device channel plugin for OpenClaw",
  plugin: vauxrPlugin,
  registerFull(api) {
    const config = resolveConfig(api);

    if (!config.url) return;
    const selected = endpoints(config);
    const g = globalThis as { __vauxrRuntime?: VauxrRuntime };
    // An in-process gateway restart preserves globals but retires the old
    // plugin API's gateway authority. Never dispatch with that stale API.
    if (!g.__vauxrRuntime?.isOwnedBy?.(api)) {
      g.__vauxrRuntime?.stop();
      g.__vauxrRuntime = new VauxrRuntime(api, config);
    }
    const runtime = g.__vauxrRuntime;
    if (runtime.origin !== selected.origin || runtime.wsUrl !== selected.wsUrl) {
      api.logger.warn("[vauxr] Server configuration changed; restart the gateway to apply it.");
      return;
    }
    const client = new VauxrAPIClient(selected.origin, () => runtime.auth.bearer(), config.otaPublicBase, config.strictTls);
    registerTools(api, client);
    api.registerCommand({
      name: "vauxr",
      description: "Vauxr connection status, pair or cancel. Never supply a credential.",
      acceptsArgs: true, requireAuth: true, requiredScopes: ["operator.admin"],
      handler: async (ctx) => ({ text: await runtime.command(ctx.args?.trim() || "status") }),
    });

    // Since OpenClaw 2026.8, non-bundled plugins need explicit consent to use
    // before_prompt_build. Without it the gateway silently blocks the hook and
    // voice sessions lose their system prompt (devices reply with markdown,
    // emojis, no follow-up tags). Warn loudly with the exact fix.
    if (!hasConversationAccess(api)) {
      api.logger.warn(
        "[vauxr] Voice system prompt injection is DISABLED: OpenClaw blocks the " +
          "before_prompt_build hook for non-bundled plugins without consent. Fix with: " +
          "openclaw config set plugins.entries.vauxr.hooks.allowConversationAccess true " +
          "— then restart the gateway.",
      );
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

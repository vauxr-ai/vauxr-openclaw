import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/core";
import { DEFAULT_VOICE_SYSTEM_PROMPT } from "./defaults.js";
import { createTopLevelChannelConfigBase } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

export interface VauxrAccount {
  accountId?: string | null;
}

// Type assertion needed: createChannelPluginBase marks capabilities as Partial
// in its return type, but createChatChannelPlugin requires it non-optional.
// We always provide capabilities, so the assertion is safe.
export const vauxrPlugin = createChatChannelPlugin<VauxrAccount>({
  base: createChannelPluginBase<VauxrAccount>({
    id: "vauxr",
    meta: { label: "Vauxr" },
    capabilities: {
      chatTypes: ["direct"],
    },
    config: createTopLevelChannelConfigBase<VauxrAccount>({
      sectionKey: "vauxr",
      resolveAccount: (cfg) => {
        const section = resolveSection(cfg);
        const url = section?.url;
        return {
          accountId: url ?? "default",
          // running/connected drive UI status indicators
          ...(url ? { running: true, connected: true } : {}),
        };
      },
      // Single-account channel — listAccountIds returns either the single
      // resolved id or an empty array if the channel isn't configured.
      listAccountIds: (cfg) => {
        const section = resolveSection(cfg);
        return section?.url ? [section.url] : [];
      },
      defaultAccountId: (cfg) => resolveSection(cfg)?.url ?? "default",
    }),
    setup: {
      resolveAccountId({ cfg }) {
        const section = resolveSection(cfg);
        return section?.url ?? "default";
      },
      applyAccountConfig({ cfg, input }) {
        const updated = structuredClone(cfg) as Record<string, unknown>;
        const channels = (updated.channels ?? {}) as Record<string, unknown>;
        channels.vauxr = {
          // Seed default voice system prompt so it's populated on first install.
          // Existing value (if any) takes precedence via spread order.
          voiceSystemPrompt: DEFAULT_VOICE_SYSTEM_PROMPT,
          ...((channels.vauxr ?? {}) as Record<string, unknown>),
          ...(input as Record<string, unknown>),
        };
        updated.channels = channels;
        return updated as OpenClawConfig;
      },
    },
  }) as Parameters<typeof createChatChannelPlugin<VauxrAccount>>[0]["base"],
  // No security/pairing — vauxr devices are trusted local hardware
  outbound: {
    // Outbound responses are delivered via the WS bridge, not the outbound adapter
    // This stub satisfies the ChannelPlugin interface
    base: {
      deliveryMode: "direct",
    },
    attachedResults: {
      channel: "vauxr",
      sendText: async () => ({ messageId: "bridge" }),
    },
  },
});

// gateway.startAccount is required for OpenClaw to mark this channel as
// "running" and "configured" in the UI. The actual bridge lifecycle is
// managed by registerFull in index.ts (which has access to the full plugin
// API). This stub holds the channel in running state until the gateway stops.
// isConfigured: tells OpenClaw the channel is configured when url is set.
vauxrPlugin.config.isConfigured = (_account: unknown, cfg: OpenClawConfig) => {
  return Boolean(resolveSection(cfg)?.url);
};

vauxrPlugin.gateway = {
  startAccount: async (ctx: { abortSignal: AbortSignal }) => {
    await new Promise<void>((resolve) => {
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
  },
};

interface VauxrSection {
  url?: string;
  token?: string;
  voiceSystemPrompt?: string;
}

function resolveSection(cfg: OpenClawConfig): VauxrSection | undefined {
  const raw = cfg as Record<string, unknown>;
  const channelsCfg = (raw.channels as Record<string, unknown> | undefined)?.vauxr as
    | VauxrSection
    | undefined;
  const pluginsCfg = (
    (raw.plugins as Record<string, unknown> | undefined)?.entries as
      | Record<string, unknown>
      | undefined
  )?.vauxr as { config?: VauxrSection } | undefined;
  return channelsCfg ?? pluginsCfg?.config;
}

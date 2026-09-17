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
    meta: { label: "Vauxr", selectionLabel: "Vauxr (voice devices)", docsPath: "/channels/vauxr", blurb: "Speak through and control Vauxr voice devices on your LAN." },
    capabilities: {
      chatTypes: ["direct"],
    },
    config: createTopLevelChannelConfigBase<VauxrAccount>({
      sectionKey: "vauxr",
      resolveAccount: (cfg) => {
        const section = resolveSection(cfg);
        const url = section?.url;
        return {
          accountId: "default",
          // Runtime status is supplied only after enrollment and socket authentication.
        };
      },
      // Single-account channel — listAccountIds returns either the single
      // resolved id or an empty array if the channel isn't configured.
      listAccountIds: (cfg) => {
        const section = resolveSection(cfg);
        return section?.url ? ["default"] : [];
      },
      defaultAccountId: () => "default",
    }),
    setup: {
      resolveAccountId({ cfg }) {
        const section = resolveSection(cfg);
        return "default";
      },
      applyAccountConfig({ cfg, input }) {
        const updated = structuredClone(cfg) as Record<string, unknown>;
        const channels = (updated.channels ?? {}) as Record<string, unknown>;
        const merged = {
          // Seed default voice system prompt so it's populated on first install.
          // Existing value (if any) takes precedence via spread order.
          voiceSystemPrompt: DEFAULT_VOICE_SYSTEM_PROMPT,
          ...((channels.vauxr ?? {}) as Record<string, unknown>),
          ...Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([key]) =>
            ['url', 'httpUrl', 'strictTls', 'voiceSystemPrompt', 'otaPublicBase', 'alsoAllow', 'targetAgent'].includes(key))),
        } as Record<string, unknown>;
        delete merged.token; // Remove obsolete shared credentials, preserving unrelated settings.
        channels.vauxr = merged;
        updated.channels = channels;
        applyToolsBySenderPolicy(updated, merged);
        return updated as OpenClawConfig;
      },
    },
  }) as Parameters<typeof createChatChannelPlugin<VauxrAccount>>[0]["base"],
  // Only scoped, enrolled channel authority can deliver physical-device voice turns.
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

// Configuration presence and authenticated connectivity are distinct.
vauxrPlugin.config.isConfigured = (_account: unknown, cfg: OpenClawConfig) => Boolean(resolveSection(cfg)?.url);
vauxrPlugin.gateway = {
  startAccount: async (ctx) => {
    if (ctx.abortSignal.aborted) return;
    const runtime = (globalThis as { __vauxrRuntime?: import("./runtime.js").VauxrRuntime }).__vauxrRuntime;
    if (!runtime) { ctx.setStatus({ accountId: ctx.accountId, running: false, connected: false, lastError: "Vauxr runtime unavailable" }); return; }
    const update = () => {
      const status = runtime.auth.status();
      ctx.setStatus({ accountId: ctx.accountId, running: true, connected: status.state === 'connected',
        lastError: status.state === 'connected' ? null : `Vauxr: ${status.state}` });
    };
    runtime.auth.onStatus = update;
    runtime.start(); update();
    try {
      await new Promise<void>(resolve => {
        if (ctx.abortSignal.aborted) { resolve(); return; }
        ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      runtime.stop(); runtime.auth.onStatus = undefined;
      ctx.setStatus({ accountId: ctx.accountId, running: false, connected: false });
    }
  },
};

interface VauxrSection {
  url?: string;
  strictTls?: boolean;
  voiceSystemPrompt?: string;
  alsoAllow?: string[];
  targetAgent?: string;
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
  const config = pluginsCfg?.config;
  return channelsCfg ?? (config as { vauxr?: VauxrSection } | undefined)?.vauxr ?? config;
}

// Key used by OpenClaw's per-sender tool policy resolver to match
// vauxr-originated runs. Format is `channel:<agentId>:<senderId>`;
// wildcard senderId applies to every vauxr device.
const VAUXR_TOOLS_BY_SENDER_KEY = "channel:vauxr:*";

/**
 * Mirror the vauxr channel's alsoAllow/targetAgent into the target agent's
 * tools.toolsBySender map. Without this expansion, vauxr-originated runs only
 * receive the messaging-profile defaults — platform tools like `gateway` and
 * `nodes` are stripped because the runtime treats third-party channels more
 * strictly than the internal `webchat` channel.
 *
 * Throws when alsoAllow is set without a resolvable targetAgent so the
 * mismatch surfaces during install/configure instead of silently no-op'ing.
 */
function applyToolsBySenderPolicy(
  cfgMut: Record<string, unknown>,
  section: Record<string, unknown>,
): void {
  const alsoAllow = Array.isArray(section.alsoAllow)
    ? (section.alsoAllow as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const targetAgent =
    typeof section.targetAgent === "string" && section.targetAgent.length > 0
      ? section.targetAgent
      : undefined;

  const agentsRoot = (cfgMut.agents ?? {}) as Record<string, unknown>;
  const agentList = Array.isArray(agentsRoot.list)
    ? (agentsRoot.list as Array<Record<string, unknown>>)
    : [];

  if (alsoAllow.length > 0) {
    if (!targetAgent) {
      throw new Error(
        "channels.vauxr.alsoAllow is set but channels.vauxr.targetAgent is missing. " +
          "Set targetAgent to the agent id that handles vauxr sessions (e.g. \"nova-cloud\").",
      );
    }
    if (!agentList.some((a) => a.id === targetAgent)) {
      const known = agentList.map((a) => a.id).filter(Boolean).join(", ") || "(none)";
      throw new Error(
        `channels.vauxr.targetAgent="${targetAgent}" does not match any agent in agents.list. ` +
          `Known agents: ${known}.`,
      );
    }
  }

  // Walk every agent: write the vauxr policy on the target, scrub it from
  // the others. Idempotent: re-running with the same config is a no-op,
  // re-running after clearing alsoAllow removes the policy everywhere.
  for (const agent of agentList) {
    const tools = (agent.tools ?? {}) as Record<string, unknown>;
    const toolsBySender = (tools.toolsBySender ?? {}) as Record<string, unknown>;
    const isTarget = agent.id === targetAgent && alsoAllow.length > 0;

    if (isTarget) {
      toolsBySender[VAUXR_TOOLS_BY_SENDER_KEY] = { alsoAllow };
      tools.toolsBySender = toolsBySender;
      agent.tools = tools;
    } else if (VAUXR_TOOLS_BY_SENDER_KEY in toolsBySender) {
      delete toolsBySender[VAUXR_TOOLS_BY_SENDER_KEY];
      if (Object.keys(toolsBySender).length === 0) {
        delete tools.toolsBySender;
      } else {
        tools.toolsBySender = toolsBySender;
      }
      if (Object.keys(tools).length === 0) {
        delete agent.tools;
      } else {
        agent.tools = tools;
      }
    }
  }
}

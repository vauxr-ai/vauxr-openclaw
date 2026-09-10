import { DEFAULT_VOICE_SYSTEM_PROMPT } from "./defaults.js";

// Transport guidance is separate from configurable voice style. Neither this
// adapter nor before_prompt_build receives the resolved source delivery mode,
// so defer to the runtime's current-turn policy rather than guessing from config.
export const VAUXR_REPLY_ROUTING_GUIDANCE =
  "Vauxr reply routing: Follow OpenClaw's current-turn source-delivery policy. " +
  "In normal automatic delivery mode, respond with a normal final assistant reply; " +
  "the Vauxr bridge carries that reply to the originating voice device. " +
  "Do not call message/send (message action=send) or vauxr_announce to deliver or duplicate that ordinary reply, " +
  "and do not look up or invent a target for it. " +
  "If the runtime explicitly requires message_tool_only delivery or says finals stay private, " +
  "follow that policy instead; do not assume a final reply will be delivered. " +
  "Use only the authorized route and available tools; if delivery is unavailable, " +
  "do not work around it with an announcement or a guessed target. " +
  "Separate outbound messages remain available when explicitly requested by the user. " +
  "Only use vauxr_announce when the user explicitly requests an announcement or speech through a Vauxr device; " +
  "being in a voice conversation is not such a request. Preserve all tool permissions and consent requirements.";

interface VoiceTurnContext {
  sessionKey?: string;
  channel?: string;
  messageProvider?: string;
}

export function isVauxrTurn(ctx: VoiceTurnContext): boolean {
  // Explicit source wins over a reused session key. Older runtimes only expose
  // the key; accept the two bridge formats, not arbitrary embedded substrings.
  const source = ctx.channel ?? ctx.messageProvider;
  if (source) return source === "vauxr";
  return /^(?:agent:[^:]+:)?vauxr:[^:]+$/.test(ctx.sessionKey ?? "");
}

export function buildVoicePromptContext(ctx: VoiceTurnContext, customPrompt?: string) {
  if (!isVauxrTurn(ctx)) return undefined;
  return {
    appendSystemContext: [customPrompt ?? DEFAULT_VOICE_SYSTEM_PROMPT, VAUXR_REPLY_ROUTING_GUIDANCE]
      .filter(Boolean)
      .join("\n\n"),
  };
}

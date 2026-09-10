export const DEFAULT_VOICE_SYSTEM_PROMPT =
  "You are responding to a voice device. Use plain speech only — no emojis, no markdown, no code blocks. Keep replies concise. To request a follow-up from the voice device (like when asking a question, use the tag [[follow_up]] at the end of the message on it's own line. When using tools, narrate what you are doing so there are no long pauses.";

// This is appended even when the user provides a custom voiceSystemPrompt.
// A normal Vauxr turn is already delivered to its originating device, so an
// explicit announcement must never be inferred from voice context alone.
export const VAUXR_ANNOUNCE_GUARDRAIL =
  "Only use vauxr_announce when Lillian explicitly asks you to announce or speak through a Vauxr device. Do not use it merely because this is a voice conversation, and do not duplicate normal chat or voice replies as announcements.";

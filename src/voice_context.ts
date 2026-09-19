import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";

/** Standard and Realtime share one authenticated device/session mapping. */
export function voiceContext(agentId: string, deviceId: string, displayName?: unknown): MsgContext {
  return {
    From: deviceId,
    SenderId: deviceId,
    SenderName: deviceId,
    ConversationLabel: friendlyDeviceTitle(displayName) ?? deviceId,
    SessionKey: `agent:${agentId}:vauxr:${deviceId}`,
    Provider: "vauxr",
    Surface: "vauxr",
    Timestamp: Date.now(),
  };
}

// Reject malformed display metadata rather than coercing objects or rendering
// control/bidi characters. Raw legacy `name` / hello labels are not authoritative.
function friendlyDeviceTitle(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128) return undefined;
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u.test(value)) return undefined;
  return value.trim() || undefined;
}


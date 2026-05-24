import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { VauxrAPIClient, Device } from "./api-client.js";

function formatDeviceList(devices: Device[]): string {
  if (devices.length === 0) return "No devices connected.";
  return devices
    .map((d) => `• ${d.name} (id: ${d.id}) — ${d.state}, last seen ${d.lastSeen}`)
    .join("\n");
}

export function registerTools(api: OpenClawPluginApi, client: VauxrAPIClient): void {
  api.registerTool(
    {
      name: "vauxr_devices",
      label: "Vauxr Devices",
      description:
        "List Vauxr voice devices currently connected to Vauxr, with their IDs, names, and connection state. Call this first if you don't know which device to target.",
      parameters: Type.Object({}),
      async execute() {
        const devices = await client.listDevices();
        return {
          content: [{ type: "text" as const, text: formatDeviceList(devices) }],
          details: { devices },
        };
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "vauxr_announce",
      label: "Vauxr Announce",
      description:
        "Announce a spoken message through a Vauxr voice device. The text will be synthesized to speech and played through the device's speaker. Use `vauxr_devices` first if you don't know the device ID.",
      parameters: Type.Object({
        device_id: Type.String({ description: "ID of the device to speak through" }),
        text: Type.String({
          description:
            "Text to speak aloud — keep it concise, plain sentences only, no markdown or emojis",
        }),
      }),
      async execute(_id, params) {
        const p = params as { device_id: string; text: string };
        await client.announce(p.device_id, p.text);
        return {
          content: [
            {
              type: "text" as const,
              text: `Announced on device ${p.device_id}: "${p.text}"`,
            },
          ],
          details: {},
        };
      },
    },
    { optional: false },
  );

  api.registerTool(
    {
      name: "vauxr_control",
      label: "Vauxr Control",
      description:
        "Send a control command to a Vauxr voice device (set volume, mute, unmute, or reboot).",
      parameters: Type.Object({
        device_id: Type.String({ description: "ID of the device to control" }),
        command: Type.Union(
          [
            Type.Literal("set_volume"),
            Type.Literal("mute"),
            Type.Literal("unmute"),
            Type.Literal("reboot"),
          ],
          { description: "The control command to send" },
        ),
        volume: Type.Optional(
          Type.Number({
            description: "Volume level 0–100, required when command is set_volume",
            minimum: 0,
            maximum: 100,
          }),
        ),
      }),
      async execute(_id, params) {
        const p = params as {
          device_id: string;
          command: "set_volume" | "mute" | "unmute" | "reboot";
          volume?: number;
        };
        const cmdParams: Record<string, unknown> | undefined =
          p.command === "set_volume" ? { volume: p.volume } : undefined;
        await client.command(p.device_id, p.command, cmdParams);
        return {
          content: [
            {
              type: "text" as const,
              text: `Sent ${p.command} to device ${p.device_id}${p.command === "set_volume" ? ` (volume: ${p.volume})` : ""}`,
            },
          ],
          details: {},
        };
      },
    },
    { optional: false },
  );
}

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { VauxrAPIClient, Device } from "./api-client.js";

function formatDeviceList(devices: Device[]): string {
  if (devices.length === 0) return "No devices connected.";
  return devices
    .map((d) => {
      const hw = [d.platform, d.fw_version].filter(Boolean).join(" ");
      const extra = hw ? `, ${hw}` : "";
      const barge = d.config?.barge_in === false ? ", barge-in off" : "";
      return `• ${d.name} (id: ${d.id}) — ${d.state}${extra}${barge}, last seen ${d.lastSeen}`;
    })
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
        "Send a control command to a Vauxr voice device (set volume, mute, unmute, reboot, ota, or set_barge_in).",
      parameters: Type.Object({
        device_id: Type.String({ description: "ID of the device to control" }),
        command: Type.Union(
          [
            Type.Literal("set_volume"),
            Type.Literal("mute"),
            Type.Literal("unmute"),
            Type.Literal("reboot"),
            Type.Literal("ota"),
            Type.Literal("set_barge_in"),
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
        url: Type.Optional(
          Type.String({
            description:
              "Firmware HTTP(S) URL for ota. Required unless otaPublicBase is configured. Must be reachable by the device (not Docker DNS).",
          }),
        ),
        enabled: Type.Optional(
          Type.Boolean({
            description:
              "Whether barge-in is enabled. Required when command is set_barge_in. Disable if speaker echo interrupts the assistant while it is talking.",
          }),
        ),
      }),
      async execute(_id, params) {
        const p = params as {
          device_id: string;
          command: "set_volume" | "mute" | "unmute" | "reboot" | "ota" | "set_barge_in";
          volume?: number;
          url?: string;
          enabled?: boolean;
        };
        let cmdParams: Record<string, unknown> | undefined;
        if (p.command === "set_volume") {
          cmdParams = { volume: p.volume };
        } else if (p.command === "ota") {
          const url = p.url?.trim() || client.defaultOtaUrl();
          if (!url) {
            throw new Error(
              "ota requires params.url, or set channels.vauxr.otaPublicBase to a LAN origin the device can fetch (not Docker DNS)",
            );
          }
          cmdParams = { url };
        } else if (p.command === "set_barge_in") {
          if (typeof p.enabled !== "boolean") {
            throw new Error("set_barge_in requires enabled: true or false");
          }
          cmdParams = { enabled: p.enabled };
        }
        await client.command(p.device_id, p.command, cmdParams);
        const extra =
          p.command === "set_volume"
            ? ` (volume: ${p.volume})`
            : p.command === "ota"
              ? ` (url: ${cmdParams?.url})`
              : p.command === "set_barge_in"
                ? ` (enabled: ${p.enabled})`
                : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Sent ${p.command} to device ${p.device_id}${extra}`,
            },
          ],
          details: {},
        };
      },
    },
    { optional: false },
  );
}

import { requestJson, validateOrigin } from "./transport.js";

export interface Device {
  id: string;
  name: string;
  state: "idle" | "listening" | "processing" | "speaking" | "offline";
  lastSeen: string;
  platform?: string;
  fw_version?: string;
  config?: { name?: string; follow_up_mode?: string; barge_in?: boolean };
}

const PAIR_STATES = ["challenge", "ready", "initiated", "approved", "consumed", "denied", "cancelled", "failed", "expired", "stale"] as const;
export interface PairingRequest {
  request_id: string;
  device_id: string;
  kind: "physical";
  display_name: string;
  status: typeof PAIR_STATES[number];
  expires_at: number;
}
export interface PhysicalConfirmation {
  request_id: string;
  device_id: string;
  code: string;
  heard_from_device: boolean;
  physical_window_open: boolean;
}
const COMMANDS = new Set(["set_volume", "mute", "unmute", "reboot", "ota", "set_barge_in"]);
const FIRMWARE_NAME = /^[A-Za-z0-9._-]+\.bin$/;
const DELIVERY_PATH = /^\/firmware-delivery\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9._-]+\.bin$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Vauxr response");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) throw new Error("Invalid Vauxr response");
  return value.replace(/vx_(?:int|dev)_[A-Za-z0-9_-]+/g, "[redacted]").replace(/[\u0000-\u001f\u007f]/g, " ");
}

export class VauxrAPIClient {
  private baseUrl: string;
  private secure: boolean;
  constructor(baseUrl: string, private token: () => Promise<string>, private otaPublicBase?: string, strictTls = false) {
    this.baseUrl = validateOrigin(baseUrl, strictTls);
    this.secure = strictTls || this.baseUrl.startsWith("https:");
    if (otaPublicBase) this.otaPublicBase = validateOrigin(otaPublicBase, this.secure);
  }
  defaultOtaUrl(filename = "satellite1.bin"): string | undefined {
    if (!/^[A-Za-z0-9_.-]+$/.test(filename)) throw new Error("Invalid firmware filename");
    return this.otaPublicBase ? `${this.otaPublicBase}/firmware/${filename}` : undefined;
  }
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestJson<T>(this.baseUrl, path, body, await this.token(), method);
  }
  async listDevices(): Promise<Device[]> {
    const rows = await this.request<unknown>("GET", "/api/devices");
    if (!Array.isArray(rows)) throw new Error("Invalid Vauxr response");
    return rows.map(value => {
      const row = object(value);
      if (!["idle", "listening", "processing", "speaking", "offline"].includes(row.state as string)) throw new Error("Invalid Vauxr response");
      const result: Device = { id: string(row.id), name: string(row.name), state: row.state as Device["state"], lastSeen: string(row.lastSeen) };
      if (row.platform !== undefined) result.platform = string(row.platform);
      if (row.fw_version !== undefined) result.fw_version = string(row.fw_version);
      if (row.config) {
        const config = object(row.config);
        result.config = {};
        if (config.name !== undefined) result.config.name = string(config.name);
        if (config.follow_up_mode !== undefined) result.config.follow_up_mode = string(config.follow_up_mode);
        if (typeof config.barge_in === "boolean") result.config.barge_in = config.barge_in;
      }
      return result;
    });
  }
  async announce(deviceId: string, text: string): Promise<void> {
    await this.request("POST", `/api/devices/${encodeURIComponent(deviceId)}/announce`, { text });
  }
  async mintFirmwareDelivery(filename: string): Promise<string> {
    if (typeof filename !== "string" || !FIRMWARE_NAME.test(filename) || /[\r\n]/.test(filename) || filename.includes("..")) throw new Error("Invalid firmware filename");
    const row = object(await this.request("POST", `/api/firmware-delivery/${encodeURIComponent(filename)}`, {}));
    if (!Number.isSafeInteger(row.expires_in) || (row.expires_in as number) < 1 || (row.expires_in as number) > 120 || typeof row.url !== "string") {
      throw new Error("Invalid firmware delivery response");
    }
    let url: URL;
    try { url = new URL(row.url); } catch { throw new Error("Invalid firmware delivery response"); }
    if (url.origin !== this.baseUrl || url.username || url.password || url.search || url.hash ||
        !DELIVERY_PATH.test(url.pathname) || !url.pathname.endsWith(`/${filename}`) ||
        row.url !== `${url.origin}${url.pathname}`) {
      throw new Error("Invalid firmware delivery response");
    }
    return url.href;
  }
  async command(deviceId: string, command: string, params?: Record<string, unknown>): Promise<void> {
    if (!COMMANDS.has(command)) throw new Error("Unsupported Vauxr command; playback URLs and administration are not available");
    let safeParams: Record<string, unknown> | undefined;
    if (command === "set_volume") {
      if (typeof params?.volume !== "number" || !Number.isFinite(params.volume) || params.volume < 0 || params.volume > 100) throw new Error("Volume must be a number from 0 to 100");
      safeParams = { volume: params.volume };
    } else if (command === "set_barge_in") {
      if (typeof params?.enabled !== "boolean") throw new Error("set_barge_in requires enabled: true or false");
      safeParams = { enabled: params.enabled };
    } else if (command === "ota") {
      let url: URL;
      try { url = new URL(params?.url as string); } catch { throw new Error("Invalid firmware URL"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search || (this.secure && url.protocol !== "https:")) throw new Error("Firmware URL must honor the selected transport and contain no credentials, query or fragment");
      safeParams = { url: url.href };
    }
    await this.request("POST", `/api/devices/${encodeURIComponent(deviceId)}/command`, { command, ...(safeParams ? { params: safeParams } : {}) });
  }
  async listPairingRequests(): Promise<PairingRequest[]> {
    const response = object(await this.request("POST", "/api/enrollment/v1/list", {}));
    if (response.version !== 1 || !Array.isArray(response.requests)) throw new Error("Invalid enrollment v1 response");
    return response.requests.map(value => {
      const row = object(value);
      if (row.kind !== "physical" || typeof row.request_id !== "string" || (row.request_id.length !== 32 || !/^[a-f0-9]{32}$/.test(row.request_id)) || typeof row.device_id !== "string" || (row.device_id.length !== 68 || !/^dev_[a-f0-9]{64}$/.test(row.device_id)) || !PAIR_STATES.includes(row.status as PairingRequest["status"]) || !Number.isSafeInteger(row.expires_at)) throw new Error("Invalid enrollment v1 response");
      return { request_id: row.request_id, device_id: row.device_id, kind: "physical", display_name: string(row.display_name), status: row.status as PairingRequest["status"], expires_at: row.expires_at as number };
    });
  }
  async confirmPairing(action: "initiate" | "approve", confirmation: PhysicalConfirmation): Promise<{ status: "initiated" | "approved"; device_id: string }> {
    if (!["initiate", "approve"].includes(action) || confirmation.heard_from_device !== true || confirmation.physical_window_open !== true || (typeof confirmation.code !== "string" || confirmation.code.length !== 8 || !/^[0-9]{8}$/.test(confirmation.code))) throw new Error("Pairing requires the exact eight digits heard locally from the intended device and explicit confirmation that its physical pairing window is still open");
    const request = (await this.listPairingRequests()).find(row => row.request_id === confirmation.request_id && row.device_id === confirmation.device_id);
    if (!request || request.status !== (action === "initiate" ? "ready" : "initiated") || Date.now() >= request.expires_at * 1000) throw new Error("Pairing request is unavailable, expired or in the wrong state; check the intended device and reopen its physical window if needed");
    const response = object(await this.request("POST", `/api/enrollment/v1/${action}`, { request_id: request.request_id, code: confirmation.code }));
    const status = action === "initiate" ? "initiated" : "approved";
    if (response.status !== status || response.device_id !== request.device_id) throw new Error("Invalid enrollment v1 response");
    return { status, device_id: request.device_id };
  }
}

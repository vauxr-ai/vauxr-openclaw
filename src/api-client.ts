export interface Device {
  id: string;
  name: string;
  state: "idle" | "listening" | "processing" | "speaking" | "offline";
  lastSeen: string;
}

export class VauxrAPIClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const errorBody = (await res.json()) as Record<string, unknown>;
        const detail = errorBody.error ?? errorBody.message;
        if (typeof detail === "string") {
          message = detail;
        }
      } catch {
        // response body wasn't JSON — keep generic message
      }

      if (res.status === 401) {
        throw new Error(`Unauthorized: ${message}`);
      }
      if (res.status === 404) {
        throw new Error(`Device not found: ${message}`);
      }
      if (res.status === 409) {
        throw new Error(`Device busy: ${message}`);
      }
      throw new Error(message);
    }

    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async listDevices(): Promise<Device[]> {
    return this.request<Device[]>("GET", "/api/devices");
  }

  async announce(deviceId: string, text: string): Promise<void> {
    await this.request<void>("POST", `/api/devices/${encodeURIComponent(deviceId)}/announce`, {
      text,
    });
  }

  async command(
    deviceId: string,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    await this.request<void>("POST", `/api/devices/${encodeURIComponent(deviceId)}/command`, {
      command,
      params,
    });
  }
}

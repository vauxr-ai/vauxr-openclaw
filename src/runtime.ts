import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { VauxrAuth } from './auth.js';
import { VauxrBridge } from './bridge.js';
import { createProtectedStore } from './secret-store.js';
import { endpoints, VauxrError } from './transport.js';

/** Instantiation is side-effect free. Only gateway start/explicit user commands do I/O. */
export class VauxrRuntime {
  readonly auth: VauxrAuth;
  readonly origin: string;
  readonly wsUrl: string;
  private bridge: VauxrBridge;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private work?: Promise<void>;
  private failures = 0;
  constructor(private readonly api: OpenClawPluginApi, config: { url: string; httpUrl?: string; strictTls?: boolean }) {
    const selected = endpoints(config);
    this.origin = selected.origin; this.wsUrl = selected.wsUrl;
    this.auth = new VauxrAuth(this.origin, this.wsUrl,
      createProtectedStore(api.runtime.state.resolveStateDir(), `${this.origin}\n${this.wsUrl}`));
    this.bridge = new VauxrBridge(api, config, this.auth);
  }
  isOwnedBy(api: OpenClawPluginApi): boolean { return this.api === api; }
  start() { if (this.running) return; this.running = true; void this.cycle(); }
  stop() { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.bridge.stop(); }
  private async cycle() {
    if (!this.running) return;
    if (this.work) { await this.work; return; }
    this.work = (async () => {
      try {
        await this.auth.tick();
        if (this.auth.status().state === 'unpaired' && this.running) await this.auth.pair();
        this.failures = 0;
      } catch { this.failures = Math.min(this.failures + 1, 4); }
      if (this.running) await this.bridge.refresh();
    })();
    try { await this.work; } finally { this.work = undefined; }
    if (!this.running) return;
    const state = this.auth.status().state;
    const base = ['pending', 'approved', 'saving'].includes(state) ? 15_000 : 60_000;
    this.timer = setTimeout(() => { void this.cycle(); }, Math.min(base * 2 ** this.failures, 300_000) + Math.random() * 1000);
  }
  async command(action: string): Promise<string> {
    if (!['status', 'pair', 'cancel'].includes(action)) return 'Use /vauxr status, /vauxr pair or /vauxr cancel. Never supply a credential.';
    if (this.work) await this.work;
    if (action !== 'status') {
      try {
        if (action === 'pair') await this.auth.pair(); else await this.auth.cancel();
        if (this.running) await this.bridge.refresh();
      } catch (error) {
        if (error instanceof VauxrError && error.code === 'already_paired') return `Vauxr: ${this.auth.status().state}. Existing enrollment is already completed or awaiting ACK; use status to resume it.`;
        // All other failures render only bounded public status.
      }
    }
    const status = this.auth.status();
    const instruction = status.state === 'pending'
      ? ` Open the owner UI at ${this.origin}, check Connect OpenClaw code ${status.userCode}, and approve before ${new Date(status.expiresAt! * 1000).toISOString()}.`
      : status.state === 're_pair_required' ? ' Owner approval is required again. Use /vauxr pair; revoke the obsolete integration in the owner UI.'
      : status.state === 'storage_error' ? ' Protected credential storage could not be verified. Repair private storage access before continuing.'
      : status.state === 'connected' ? ' Select this integration as the active channel in the owner UI to route voice.' : '';
    return `Vauxr: ${status.state}.${instruction}`;
  }
}

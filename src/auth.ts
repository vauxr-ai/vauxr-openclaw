import { createHash, randomBytes } from "node:crypto";
import { requestJson, validateOrigin, VauxrError } from "./transport.js";

export type AuthState = 'storage_unavailable' | 'unpaired' | 'pending' | 'approved' | 'saving' |
  'connecting' | 'connected' | 'disconnected' | 'denied' | 'expired' | 'cancelled' | 'failed' |
  're_pair_required' | 'storage_error' | 'transport_error';
export interface AuthStatus { state: AuthState; userCode?: string; expiresAt?: number }
interface Pending {
  request_id: string; request_secret: string; origin: string; display_name: string; expires_at: number;
}
export interface SecretRecord {
  version: 1; origin: string; wsUrl: string; pending?: Pending; serverId?: string;
  subject?: string; credential?: string; enrollmentAck?: boolean;
  rotation?: { operationId: string; credential: string; credentialId: string };
  terminal?: AuthState;
}
/** Plugin-internal port, NOT an OpenClaw runtime API. secret-store.ts adapts the verified SDK.
 * Implementations must atomically commit/flush a protected record, retaining the old
 * record on failure. The supported SDK adapter adds strict flush and readback. */
export interface ProtectedStore {
  read(): Promise<SecretRecord | undefined>;
  commit(record: SecretRecord): Promise<void>;
}
type Wire = Record<string, unknown>;
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const credential = (v: unknown): v is string => typeof v === 'string' && /^vx_int_[A-Za-z0-9_-]{43}$/.test(v);
const invalid = () => new VauxrError('invalid_contract');

export class VauxrAuth {
  #record?: SecretRecord;
  #status: AuthStatus;
  #operation: Promise<void> = Promise.resolve();
  #rejected = false;
  constructor(readonly origin: string, readonly wsUrl: string, private store?: ProtectedStore,
    private now = () => Date.now() / 1000) {
    validateOrigin(origin);
    this.#status = { state: store ? 'unpaired' : 'storage_unavailable' };
  }
  onStatus?: (status: AuthStatus) => void;
  status(): AuthStatus { return { ...this.#status }; }
  private state(state: AuthState) { if (this.#rejected) state = 're_pair_required'; this.#status = { state }; this.onStatus?.(this.status()); }
  private async save(record: SecretRecord) {
    if (this.#rejected) record = { ...record, terminal: 're_pair_required' };
    if (!this.store) throw new VauxrError('storage_unavailable');
    try {
      await this.store.commit(structuredClone(record));
      const saved = await this.store.read();
      if (JSON.stringify(saved) !== JSON.stringify(record)) throw 0;
      this.#record = saved;
    } catch { this.state('storage_error'); throw new VauxrError('storage_error'); }
  }
  private async load() {
    if (!this.store) throw new VauxrError('storage_unavailable');
    try { this.#record = await this.store.read(); }
    catch { this.state('storage_error'); throw new VauxrError('storage_error'); }
    const r = this.#record;
    if (r && ((r.terminal !== undefined && !['denied', 'expired', 'cancelled', 'failed', 're_pair_required'].includes(r.terminal)) || (r.credential !== undefined && !credential(r.credential)) ||
      (r.rotation && (!hex(r.rotation.operationId) || !credential(r.rotation.credential))) ||
      (r.pending && (!hex(r.pending.request_id) || !/^[a-f0-9]{64}$/.test(r.pending.request_secret) ||
        !Number.isSafeInteger(r.pending.expires_at) || r.pending.origin !== r.origin)) ||
      (!r.pending && !r.credential))) {
      this.state('storage_error'); throw new VauxrError('storage_error');
    }
    if (r && (r.version !== 1 || r.origin !== this.origin || r.wsUrl !== this.wsUrl)) {
      this.state('re_pair_required'); throw new VauxrError('server_binding_changed');
    }
  }
  private proof() {
    const p = this.#record?.pending;
    if (!p) throw invalid();
    return { request_id: p.request_id, request_secret: p.request_secret };
  }
  private async integration(action: string, extra = {}) {
    return requestJson<Wire>(this.origin, `/api/integrations/v1/${action}`, { ...this.proof(), ...extra });
  }
  private checkIntegration(row: Wire) {
    const r = this.#record!, p = r.pending!;
    if (row.version !== 1 || row.request_id !== p.request_id || row.origin !== this.origin ||
      row.channel_id !== `int_${p.request_id}` || row.expires_at !== p.expires_at ||
      row.display_name !== p.display_name || !hex(row.server_id) || (r.serverId && row.server_id !== r.serverId)) throw invalid();
    return row;
  }
  private code(p: Pending) {
    return createHash('sha256').update('vauxr-integration-code-v1\0').update(Buffer.from(p.request_id + p.request_secret, 'hex'))
      .update(String(p.expires_at)).digest('hex').slice(0, 8).toUpperCase();
  }
  /** Explicit local setup/re-pair only; never starts enrollment after revocation by itself. */
  async pair(displayName = 'OpenClaw') {
    return this.exclusive(async () => {
      await this.load();
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/.test(displayName)) throw new VauxrError('invalid_display_name');
      const old = this.#record;
      if (old?.pending && !old.terminal && !old.credential) { await this.advanceEnrollment(); return; }
      if (old?.credential && !old.terminal) throw new VauxrError('already_paired');
      this.#rejected = false;
      const pending: Pending = { request_id: randomBytes(16).toString('hex'), request_secret: randomBytes(32).toString('hex'),
        origin: this.origin, display_name: displayName, expires_at: Math.floor(this.now()) + 300 };
      // Commit request binding BEFORE the first request so interruption is retryable.
      await this.save({ version: 1, origin: this.origin, wsUrl: this.wsUrl, pending });
      await this.advanceEnrollment(true);
    });
  }
  async cancel() {
    return this.exclusive(async () => {
      await this.load();
      if (!this.#record?.pending || (this.#record.credential && !this.#record.enrollmentAck)) throw new VauxrError('already_paired');
      const row = this.checkIntegration(await this.integration('cancel'));
      if (row.state !== 'cancelled') throw invalid();
      await this.terminal('cancelled');
    });
  }
  async tick() {
    return this.exclusive(async () => {
      await this.load();
      if (!this.#record) { this.state('unpaired'); return; }
      if (this.#record.terminal) { this.state(this.#record.terminal); return; }
      if (this.#record.enrollmentAck || !this.#record.credential) await this.advanceEnrollment();
      else await this.advanceRotation();
    });
  }
  private exclusive(action: () => Promise<void>): Promise<void> {
    const next = this.#operation.catch(() => undefined).then(async () => {
      try { await action(); }
      catch (e) {
        if (e instanceof VauxrError && e.status === 401 && this.#record?.credential) await this.terminal('re_pair_required');
        else if (e instanceof VauxrError && ['already_paired', 'invalid_display_name'].includes(e.code)) { /* Local command error leaves connection status intact. */ }
        else if (!['storage_unavailable', 'storage_error', 're_pair_required'].includes(this.#status.state)) this.state('transport_error');
        throw new VauxrError(e instanceof VauxrError ? e.code : 'connection_interrupted', e instanceof VauxrError ? e.status : 0);
      }
    });
    this.#operation = next;
    return next;
  }
  private async terminal(state: AuthState) {
    this.state(state);
    if (this.#record) await this.save({ ...this.#record, terminal: state });
  }
  private async advanceEnrollment(first = false) {
    const r = this.#record!, p = r.pending!;
    let row: Wire;
    if (first) row = await requestJson(this.origin, '/api/integrations/v1/request', p);
    else {
      try { row = await this.integration('status'); }
      catch (e) {
        if (e instanceof VauxrError && e.status === 404 && this.now() < p.expires_at)
          row = await requestJson(this.origin, '/api/integrations/v1/request', p);
        else if (e instanceof VauxrError && e.status === 404) { await this.terminal('expired'); return; }
        else throw e;
      }
    }
    this.checkIntegration(row);
    if (!r.serverId) await this.save({ ...r, serverId: row.server_id as string, subject: row.channel_id as string });
    const terminal = ({ denied: 'denied', cancelled: 'cancelled', failed: 'failed', expired: 'expired', stale: 're_pair_required', revoked: 're_pair_required' } as Record<string, AuthState>)[String(row.state)];
    if (terminal) { await this.terminal(terminal); return; }
    if (row.state === 'pending') {
      this.#status = { state: 'pending', userCode: this.code(p), expiresAt: p.expires_at }; this.onStatus?.(this.status()); return;
    }
    if (row.state === 'approved') {
      this.state('approved');
      row = this.checkIntegration(await this.integration('deliver'));
      if (row.state !== 'delivered' || row.save_required !== true || !credential(row.credential) || !hex(row.credential_id)) throw invalid();
      this.state('saving');
      await this.save({ ...this.#record!, credential: row.credential, enrollmentAck: true });
    } else if (row.state === 'delivered' && !this.#record!.credential) {
      // No redisclosure exists. Cancel the disabled, undelivered credential if possible.
      try { await this.integration('cancel'); } catch { /* terminal locally even if cancellation is uncertain */ }
      await this.terminal('re_pair_required'); return;
    } else if (row.state !== 'delivered' && row.state !== 'completed') throw invalid();
    if (!this.#record!.credential) { await this.terminal('re_pair_required'); return; }
    if (this.#record!.enrollmentAck) {
      // A previous atomic rename may have succeeded while fsync failed. Recommit
      // and flush on every resumed ACK; a readable file alone is not durability.
      await this.save(this.#record!);
      if (this.#rejected) return;
      const ack = this.checkIntegration(await this.integration('ack', { credential: this.#record!.credential, saved: true }));
      if (ack.state !== 'completed') throw invalid();
      await this.save({ ...this.#record!, enrollmentAck: false });
    }
    this.state('connecting');
  }
  private checkRotation(row: Wire, id?: string) {
    if (row.version !== 1 || row.role !== 'integration' || row.subject !== this.#record!.subject ||
      row.action !== 'rotate' || !hex(row.operation_id) || (id && row.operation_id !== id) ||
      typeof row.expires_at !== 'number' || typeof row.overlap_until !== 'number') throw invalid();
    return row;
  }
  private async lifecycle(action: string, body: unknown, token: string) {
    return requestJson<Wire>(this.origin, `/api/lifecycle/v1/${action}`, body, token);
  }
  private async advanceRotation() {
    let r = this.#record!;
    if (!r.rotation) {
      const row = await this.lifecycle('poll', {}, r.credential!);
      if (row.version === 1 && row.state === 'idle') { if (this.#status.state !== 'connected') this.state('connecting'); return; }
      this.checkRotation(row);
      if (row.state === 'delivered') { await this.terminal('re_pair_required'); return; }
      if (row.state === 'expired') { this.state('connecting'); return; }
      if (row.state !== 'pending' && row.state !== 'queued') throw invalid();
      const next = this.checkRotation(await this.lifecycle('deliver', { operation_id: row.operation_id }, r.credential!), row.operation_id as string);
      if (next.state !== 'delivered' || next.save_required !== true || !credential(next.credential) || !hex(next.credential_id)) throw invalid();
      await this.save({ ...r, rotation: { operationId: next.operation_id as string, credential: next.credential, credentialId: next.credential_id as string } });
      r = this.#record!;
    }
    const next = r.rotation!;
    await this.save(r);
    if (this.#rejected) return;
    const ack = this.checkRotation(await this.lifecycle('ack', { operation_id: next.operationId, saved: true }, next.credential), next.operationId);
    if (!['acknowledged', 'completed'].includes(ack.state as string)) throw invalid();
    await this.save({ ...r, credential: next.credential, rotation: undefined });
    this.state('connecting');
  }
  /** Internal network capability. Never register this as a tool/status/config field. */
  async bearer(): Promise<string> {
    if (this.#rejected || !this.#record?.credential || this.#record.enrollmentAck || this.#record.terminal ||
      ['storage_error', 'storage_unavailable', 're_pair_required'].includes(this.#status.state)) throw new VauxrError('re_pair_required');
    if (this.#record.rotation) throw new VauxrError('rotation_pending');
    return this.#record.credential;
  }
  connected() {
    if (!this.#rejected && this.#record?.credential && !this.#record.terminal && !this.#record.enrollmentAck &&
      ['connecting', 'disconnected', 'connected'].includes(this.#status.state)) this.state('connected');
  }
  subject(): string | undefined { return this.#record?.subject; }
  disconnected() { if (this.#status.state === 'connected') this.state('disconnected'); }
  async rejected() {
    this.#rejected = true;
    await this.exclusive(() => this.terminal('re_pair_required'));
  }
}

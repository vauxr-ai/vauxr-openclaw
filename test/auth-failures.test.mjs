import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { VauxrAuth } from '../dist/src/auth.js';

const oldCredential = `vx_int_${'A'.repeat(43)}`;
const nextCredential = `vx_int_${'B'.repeat(43)}`;
const operationId = '1'.repeat(32);
const subject = `int_${'2'.repeat(32)}`;
const rotation = state => ({ version: 1, role: 'integration', subject, action: 'rotate', operation_id: operationId,
  expires_at: 2_000_000_000, overlap_until: 2_000_000_060, state });
async function fixture(t, deliverGate) {
  let acknowledgments = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* Consume synthetic test protocol bodies. */ }
    let value;
    if (req.url.endsWith('/poll')) value = rotation('pending');
    else if (req.url.endsWith('/deliver')) {
      await deliverGate?.();
      value = { ...rotation('delivered'), save_required: true, credential: nextCredential, credential_id: '3'.repeat(32) };
    } else if (req.url.endsWith('/ack')) {
      acknowledgments++;
      value = rotation('acknowledged');
    } else { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const wsUrl = origin.replace('http:', 'ws:') + '/channel';
  const initial = { version: 1, origin, wsUrl, subject, credential: oldCredential };
  return { origin, wsUrl, initial, acknowledgments: () => acknowledgments };
}

test('uncertain atomic publication must be durably recommitted before ACK on retry and restart', async t => {
  for (const restart of [false, true]) await t.test(restart ? 'restart' : 'same process retry', async t => {
    const f = await fixture(t);
    let persisted = f.initial;
    let flushFails = true;
    const store = {
      async read() { return structuredClone(persisted); },
      async commit(record) {
        persisted = structuredClone(record);
        if (flushFails) throw new Error('synthetic-fsync-failure');
      },
    };
    let auth = new VauxrAuth(f.origin, f.wsUrl, store);
    await assert.rejects(auth.tick());
    assert.equal(f.acknowledgments(), 0);
    if (restart) auth = new VauxrAuth(f.origin, f.wsUrl, store);
    await assert.rejects(auth.tick());
    assert.equal(f.acknowledgments(), 0, 'an on-disk record is not proof that failed fsync succeeded');
    flushFails = false;
    await auth.tick();
    assert.equal(f.acknowledgments(), 1);
    assert.equal(await auth.bearer(), nextCredential);
  });
});

test('a late channel.ready must not erase storage_error or enable credential use', async t => {
  const f = await fixture(t);
  const auth = new VauxrAuth(f.origin, f.wsUrl, {
    async read() { return structuredClone(f.initial); },
    async commit() { throw new Error('synthetic-fsync-failure'); },
  });
  await assert.rejects(auth.tick());
  assert.equal(auth.status().state, 'storage_error');
  auth.connected();
  assert.equal(auth.status().state, 'storage_error');
  await assert.rejects(auth.bearer());
});

test('revocation during a lifecycle delivery cannot be overwritten by its stale save', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let arrived;
  const deliveryStarted = new Promise(resolve => { arrived = resolve; });
  const f = await fixture(t, async () => { arrived(); await gate; });
  let persisted = f.initial;
  const auth = new VauxrAuth(f.origin, f.wsUrl, {
    async read() { return structuredClone(persisted); },
    async commit(record) { persisted = structuredClone(record); },
  });
  const tick = auth.tick();
  await deliveryStarted;
  const rejected = auth.rejected();
  release();
  await Promise.allSettled([tick, rejected]);
  assert.equal(auth.status().state, 're_pair_required');
  assert.equal(persisted.terminal, 're_pair_required');
  await assert.rejects(auth.bearer());
});

// The emitted bridge methods are callable for deterministic event-race tests.
const { VauxrBridge } = await import('../dist/src/bridge.js');
test('channel.ready cannot enable dispatch after auth refuses the connected transition', () => {
  const auth = { subject: () => subject, status: () => ({ state: 'storage_error' }), connected() {}, disconnected() {} };
  const bridge = new VauxrBridge({ logger: { debug() {}, warn() {} } }, { url: 'http://127.0.0.1:8080' }, auth);
  bridge.started = true;
  bridge.handleFrame({ type: 'channel.ready', channelId: subject });
  assert.equal(bridge.authenticated, false);
});

test('a retired voice turn failure cannot emit frames on the replacement connection', async () => {
  let rejectTurn;
  const gate = new Promise((_, reject) => { rejectTurn = reject; });
  const api = {
    config: { agents: { list: [{ id: 'assistant', default: true }] } },
    logger: { info() {}, warn() {} },
    runtime: { channel: {
      session: { resolveStorePath() { return '/unused'; }, recordInboundSession() {} },
      inbound: { async run() { await gate; } },
    } },
  };
  const bridge = new VauxrBridge(api, { url: 'http://127.0.0.1:8080' });
  const oldTurn = bridge.dispatchTranscript('device-1', 'synthetic voice text');
  bridge.retireTurns();
  const frames = [];
  bridge.authenticated = true;
  bridge.ws = { readyState: 1, send(frame) { frames.push(JSON.parse(frame)); } };
  rejectTurn(new Error('synthetic late dispatch failure'));
  await oldTurn;
  assert.deepEqual(frames, []);
});

test('stop invalidates a pending credential refresh instead of reopening a stopped service', async () => {
  let release;
  const bearer = new Promise(resolve => { release = resolve; });
  const auth = { async bearer() { return bearer; }, disconnected() {} };
  const bridge = new VauxrBridge({ logger: { debug() {}, warn() {} } }, { url: 'http://127.0.0.1:8080' }, auth);
  let starts = 0;
  bridge.start = () => { starts++; };
  const refresh = bridge.refresh();
  bridge.stop();
  release(oldCredential);
  await refresh;
  assert.equal(starts, 0);
});

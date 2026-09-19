import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { VauxrAPIClient } from '../dist/src/api-client.js';
import { VauxrAuth } from '../dist/src/auth.js';
import { createProtectedStore } from '../dist/src/secret-store.js';
import { requestJson } from '../dist/src/transport.js';

const HEAD = '16968a73b7610c917a9922d94d8c7ef187f7dda3';
const source = process.env.VAUXR_CONTRACT_SOURCE;
// This suite is explicit, never silently substitutes mocks when source is absent.
test('real versioned server enrollment and lifecycle contracts', { skip: source ? false : 'Set VAUXR_CONTRACT_SOURCE to the reviewed server checkout' }, async t => {
  assert.equal(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), HEAD);
  execFileSync('git', ['-C', source, 'diff', '--quiet', 'HEAD', '--', 'src', 'tests/fixtures']);
  for (const name of ['integration-v1.json', 'lifecycle-v1.json', 'enrollment-v1-vector.json']) {
    assert.equal(await readFile(resolve(source, 'tests/fixtures', name), 'utf8'), await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
  }
  await mkdir(resolve('test-artifacts'), { recursive: true });
  const data = await mkdtemp(resolve('test-artifacts/real-contract-'));
  const child = spawn(process.env.PYTHON ?? 'python3', ['-B', 'test/server-contract.py'], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', VAUXR_CONTRACT_SOURCE: source, VAUXR_CONTRACT_DATA: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => { child.kill(); await rm(data, { recursive: true, force: true }); });
  const ready = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('Contract server startup timed out')), 10000);
    createInterface({ input: child.stdout }).once('line', line => { clearTimeout(timer); res(JSON.parse(line)); });
    child.once('exit', () => { clearTimeout(timer); rej(new Error(`Contract server failed to start: ${stderr.replace(/vx_\S+/g, '[redacted]')}`)); });
  });
  assert.equal(ready.head, HEAD);
  const origin = ready.origin;
  const ws = origin.replace('http:', 'ws:') + '/agent';
  let offset = 0;
  const now = () => Date.now() / 1000 + offset;
  const control = (action, extra = {}) => requestJson(origin, '/api/fixture/control', { action, ...extra });
  const clock = async seconds => { offset += seconds; await control('clock', { seconds }); };
  let storeIndex = 0;
  // Exercise the production OpenClaw SDK adapter, scoped to disposable test state.
  const storage = () => createProtectedStore(data, `contract-case-${storeIndex++}`);
  const connect = async auth => {
    const policy = await requestJson(origin, '/api/fixture/policy', {}, await auth.bearer());
    assert.equal(policy['agent.connect'], true);
    auth.connected();
    assert.equal(auth.status().state, 'connected');
    return policy;
  };

  await t.test('owner approval matches code; pending setup survives both restarts; scopes are bounded', async () => {
    const store = storage();
    let auth = new VauxrAuth(origin, ws, store, now);
    await auth.pair();
    assert.equal(auth.status().state, 'pending');
    const code = auth.status().userCode;
    await control('restart');
    auth = new VauxrAuth(origin, ws, store, now);
    await auth.tick();
    assert.equal(auth.status().userCode, code);
    await control('approve', { code });
    // Server durably accepts ACK then the HTTP response is lost.
    await control('drop', { path: '/api/integrations/v1/ack' });
    await assert.rejects(auth.tick());
    assert.equal((await store.read()).enrollmentAck, true);
    await control('restart');
    auth = new VauxrAuth(origin, ws, store, now);
    await auth.tick();
    assert.equal((await store.read()).enrollmentAck, false);
    const policy = await connect(auth);
    for (const operation of ['devices.list', 'voice.respond', 'device.announce', 'device.control', 'device.playback', 'firmware.initiate']) assert.equal(policy[operation], true, operation);
    for (const operation of ['owner.admin', 'credential.create', 'credential.disclose', 'credential.rotate', 'credential.revoke', 'device.configure', 'pair.initiate', 'pair.approve']) assert.equal(policy[operation], false, operation);
    await assert.rejects(requestJson(origin, '/api/lifecycle/v1/rotate', { operation_id: 'a'.repeat(32), role: 'integration', subject: (await store.read()).subject }, await auth.bearer()), { code: 'operation_denied' });

    // A physical device proves its key before the integration can initiate AND approve.
    const physical = await control('physical');
    const client = new VauxrAPIClient(origin, () => auth.bearer());
    const body = { request_id: physical.request_id, device_id: physical.device_id, code: physical.code,
      heard_from_device: true, physical_window_open: true };
    const listed = await client.listPairingRequests();
    const listedPhysical = listed.find(row => row.request_id === body.request_id);
    assert.equal(listedPhysical.device_id, body.device_id);
    assert.deepEqual(Object.keys(listedPhysical).sort(), ['device_id', 'display_name', 'expires_at', 'kind', 'request_id', 'status']);
    await assert.rejects(client.confirmPairing('approve', body));
    await assert.rejects(client.confirmPairing('initiate', { ...body, device_id: 'dev_' + 'a'.repeat(64) }));
    await assert.rejects(client.confirmPairing('initiate', { ...body, request_id: 'malformed' }));
    await assert.rejects(client.confirmPairing('initiate', { ...body, heard_from_device: false }));
    const mismatch = { ...body, code: body.code === '00000000' ? '11111111' : '00000000' };
    await assert.rejects(client.confirmPairing('initiate', mismatch));
    assert.equal((await client.confirmPairing('initiate', body)).status, 'initiated');
    const approved = await client.confirmPairing('approve', body);
    assert.equal(approved.status, 'approved');
    assert.deepEqual(Object.keys(approved).sort(), ['device_id', 'status']);
    const unproved = await control('physical', { prove: false });
    await assert.rejects(requestJson(origin, '/api/enrollment/v1/initiate', { request_id: unproved.request_id, code: '00000000' }, await auth.bearer()));

    const elapsed = await control('physical');
    await clock(301);
    await assert.rejects(requestJson(origin, '/api/enrollment/v1/initiate', { request_id: elapsed.request_id, code: elapsed.code }, await auth.bearer()));

    const old = await auth.bearer();
    await control('rotate');
    await control('drop', { path: '/api/lifecycle/v1/ack' });
    await assert.rejects(auth.tick());
    assert.equal(Boolean((await store.read()).rotation), true);
    // Old token already retired despite the missing ACK reply.
    await assert.rejects(requestJson(origin, '/api/fixture/policy', {}, old), { status: 401 });
    await control('restart');
    auth = new VauxrAuth(origin, ws, store, now);
    await auth.tick();
    assert.equal((await store.read()).rotation, undefined);
    assert.equal(old === await auth.bearer(), false);
    await connect(auth);
    assert.equal(JSON.stringify(auth.status()).includes('vx_int_'), false);
    await control('revoke');
    await assert.rejects(auth.tick(), { status: 401 });
    assert.equal(auth.status().state, 're_pair_required');
    auth = new VauxrAuth(origin, ws, store, now);
    await auth.tick();
    assert.equal(auth.status().state, 're_pair_required');
    await assert.rejects(auth.bearer());
  });

  await t.test('denied and expired software setup remain truthful after restart', async () => {
    for (const terminal of ['denied', 'expired']) {
      const store = storage();
      let auth = new VauxrAuth(origin, ws, store, now);
      await auth.pair();
      if (terminal === 'denied') {
        await assert.rejects(control('mismatch'));
        await control('deny');
      } else await clock(301);
      await auth.tick();
      assert.equal(auth.status().state, terminal);
      await control('restart');
      auth = new VauxrAuth(origin, ws, store, now);
      await auth.tick();
      assert.equal(auth.status().state, terminal);
      await assert.rejects(auth.bearer());
    }
  });
  await t.test('cancelled request and lost enrollment delivery never activate a credential', async () => {
    for (const lost of [false, true]) {
      const store = storage();
      let auth = new VauxrAuth(origin, ws, store, now);
      await auth.pair();
      if (lost) {
        await control('approve', { code: auth.status().userCode });
        await control('drop', { path: '/api/integrations/v1/deliver' });
        await assert.rejects(auth.tick());
        assert.equal(Boolean((await store.read()).credential), false);
      } else await auth.cancel();
      await control('restart');
      auth = new VauxrAuth(origin, ws, store, now);
      await auth.tick();
      assert.equal(auth.status().state, lost ? 're_pair_required' : 'cancelled');
      await assert.rejects(auth.bearer());
    }
  });

  await t.test('offline queued expiry preserves old credential; lost rotation delivery requires re-pair', async () => {
    const store = storage();
    let auth = new VauxrAuth(origin, ws, store, now);
    await auth.pair();
    await control('approve', { code: auth.status().userCode });
    await auth.tick();
    const old = await auth.bearer();
    await control('rotate');
    await clock(86401);
    await control('restart');
    auth = new VauxrAuth(origin, ws, store, now);
    await auth.tick();
    assert.equal(old === await auth.bearer(), true);
    await connect(auth);
    await control('rotate');
    await control('drop', { path: '/api/lifecycle/v1/deliver' });
    await assert.rejects(auth.tick());
    assert.equal(Boolean((await store.read()).rotation), false);
    await control('restart');
    auth = new VauxrAuth(origin, ws, store, now);
    await auth.tick();
    assert.equal(auth.status().state, 're_pair_required');
    await assert.rejects(auth.bearer());
    await clock(301);
    await assert.rejects(requestJson(origin, '/api/lifecycle/v1/poll', {}, old), { status: 401 });
  });

  await t.test('saved rotation without ACK expires both credentials and persists re-pair requirement', async () => {
    const store = storage();
    let auth = new VauxrAuth(origin, ws, store, now);
    await auth.pair();
    await control('approve', { code: auth.status().userCode });
    await auth.tick();
    const old = await auth.bearer();
    await control('rotate');
    await control('drop', { path: '/api/lifecycle/v1/ack', before: true });
    await assert.rejects(auth.tick());
    assert.equal(Boolean((await store.read()).rotation), true);
    await clock(301);
    await control('restart');
    auth = new VauxrAuth(origin, ws, store, now);
    await assert.rejects(auth.tick(), { status: 401 });
    assert.equal(auth.status().state, 're_pair_required');
    await assert.rejects(requestJson(origin, '/api/fixture/policy', {}, old), { status: 401 });
    auth = new VauxrAuth(origin, ws, store, now);
    await auth.tick();
    assert.equal(auth.status().state, 're_pair_required');
    await assert.rejects(auth.bearer());
  });
  assert.equal(/vx_(int|dev)_/.test(stderr), false, 'server logs must not disclose credentials');
});

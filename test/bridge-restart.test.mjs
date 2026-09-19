import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VauxrAuth } from '../dist/src/auth.js';
import { VauxrBridge } from '../dist/src/bridge.js';

const source = process.env.VAUXR_RESTART_SOURCE;
const until = async check => {
  const deadline = Date.now() + 12000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for bridge recovery');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('production bridge reconnects across server process restarts despite failed lifecycle poll, without re-pair',
  { skip: source ? false : 'Set VAUXR_RESTART_SOURCE to the Vauxr feature worktree' }, async t => {
    const data = await mkdtemp(join(tmpdir(), 'vauxr-restart-'));
    let child, bridge;
    const logs = [];
    const stopServer = async () => {
      if (!child) return;
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
      child = undefined;
    };
    t.after(async () => { bridge?.stop(); await stopServer(); await rm(data, {recursive:true, force:true}); });
    const startServer = async (port = 0) => {
      child = spawn(process.env.PYTHON ?? 'python3', ['-B', 'test/restart-server.py'], {
        env: {...process.env, DATA_DIR:data, OPENCLAW_URL:'', RESTART_PORT:String(port)},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      const lines = createInterface({ input: child.stdout });
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server startup timed out: ${errors}`)), 8000);
        lines.once('line', line => {clearTimeout(timer); lines.close(); resolve(JSON.parse(line));});
        child.once('exit', () => {clearTimeout(timer); reject(new Error(`server exited: ${errors}`));});
      });
    };
    const ready = await startServer();
    const origin = `http://127.0.0.1:${ready.port}`, wsUrl = origin.replace('http:', 'ws:') + '/agent';
    const saved = {version:1, origin, wsUrl, subject:ready.subject, credential:`vx_int_${'A'.repeat(43)}`};
    let writes = 0;
    const auth = new VauxrAuth(origin, wsUrl, {
      async read(){return structuredClone(saved);},
      async commit(){writes++; throw new Error('restart must not change pairing');},
    });
    await auth.tick();
    const api = {config:{}, logger:Object.fromEntries(['debug','info','warn','error'].map(k => [k, m => logs.push(m)])),
      runtime:{events:{onAgentEvent(){return () => {};}}}};
    bridge = new VauxrBridge(api, {url:origin}, auth);
    bridge.start();
    await until(() => auth.status().state === 'connected');
    for (let restart = 0; restart < 2; restart++) {
      await stopServer();
      await until(() => !bridge.authenticated);
      await assert.rejects(auth.tick());
      assert.equal(auth.status().state, 'transport_error');
      const failed = logs.filter(m => m.includes('connection failed')).length;
      await until(() => logs.filter(m => m.includes('connection failed')).length > failed);
      assert.equal((await startServer(ready.port)).subject, ready.subject);
      // No successful HTTP poll/refresh/start/pair rescues this connection.
      await until(() => auth.status().state === 'connected' && bridge.authenticated);
      assert.equal(await auth.bearer(), saved.credential);
      assert.equal(bridge.started, true);
    }
    assert.equal(writes, 0);
    assert.equal(logs.filter(m => m.includes('Agent authenticated')).length, 3);
  });

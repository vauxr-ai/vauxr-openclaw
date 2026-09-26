import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import entry from '../dist/index.js';
import { vauxrPlugin } from '../dist/src/channel.js';
import { VauxrRuntime } from '../dist/src/runtime.js';

const config = () => ({ channels: { vauxr: { url: 'http://127.0.0.1:1', voiceSystemPrompt: 'Custom voice prompt',
  targetAgent: 'assistant', alsoAllow: ['custom_tool'], otaPublicBase: 'http://127.0.0.1:1' } },
  agents: { list: [{ id: 'assistant', tools: { unrelated: true } }] },
  plugins: { entries: { vauxr: { enabled: true, hooks: { allowConversationAccess: true } } } },
  speech: { provider: 'preserved-fixture' } });

test('setup preserves speech, voice prompt and user policies while dropping obsolete credential input', () => {
  const cfg = config(), original = structuredClone(cfg);
  cfg.channels.vauxr.token = 'obsolete-test-only';
  const updated = vauxrPlugin.setup.applyAccountConfig({ cfg, input: { token: 'ignored-test-only', httpUrl: 'http://127.0.0.1:2' } });
  assert.equal(updated.channels.vauxr.token, undefined);
  assert.equal(updated.channels.vauxr.voiceSystemPrompt, original.channels.vauxr.voiceSystemPrompt);
  assert.deepEqual(updated.speech, original.speech);
  assert.equal(updated.agents.list[0].tools.unrelated, true);
  assert.deepEqual(updated.agents.list[0].tools.toolsBySender['channel:vauxr:*'], { alsoAllow: ['custom_tool'] });
  assert.equal(cfg.channels.vauxr.token, 'obsolete-test-only');
  const account = vauxrPlugin.config.resolveAccount(updated);
  assert.equal(account.connected, undefined);
  assert.equal(account.accountId, 'default');
});

test('entry introspection registers safe commands/tools, preserves custom voice prompt and does no storage/network I/O', async () => {
  delete globalThis.__vauxrRuntime;
  const tools = [], commands = [], hooks = [];
  const cfg = config(), original = structuredClone(cfg);
  const directory = new URL('../test-artifacts/must-not-create-introspection', import.meta.url).pathname;
  const api = { config: cfg, pluginConfig: {}, registrationMode: 'full', logger: { warn() {}, info() {} },
    registerChannel() {}, registerTool(tool) { tools.push(tool); }, registerCommand(command) { commands.push(command); },
    on(name, callback) { hooks.push({name,callback}); }, runtime: { state: { resolveStateDir() { return directory; } } } };
  await entry.register(api);
  assert.equal(existsSync(directory), false);
  assert.deepEqual(cfg, original);
  assert.deepEqual(tools.map(x=>x.name).sort(), ['vauxr_announce','vauxr_control','vauxr_devices','vauxr_pairing']);
  assert.equal(commands[0].requireAuth, true);
  assert.deepEqual(commands[0].requiredScopes, ['operator.admin']);
  assert.equal(hooks[0].callback({}, { sessionKey: 'agent:assistant:vauxr:device' }).appendSystemContext, 'Custom voice prompt');
  assert.equal(hooks[0].callback({}, { sessionKey: 'agent:assistant:chat' }), undefined);
  const result = await commands[0].handler({ args: 'status' });
  assert.match(result.text, /unpaired/);
  assert.equal(existsSync(directory), false);
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url)));
  assert.deepEqual(manifest.contracts.tools.sort(), tools.map(x=>x.name).sort());
  assert.equal(manifest.configSchema.required, undefined, 'channel config must not require duplicate plugin config');
  delete globalThis.__vauxrRuntime;
});

test('new gateway registration retires the old runtime and binds dispatch to the new API', async () => {
  delete globalThis.__vauxrRuntime;
  const api = () => ({ config: config(), pluginConfig: {}, registrationMode: 'full',
    logger: { warn() {}, info() {} }, registerChannel() {}, registerTool() {},
    registerCommand() {}, on() {},
    runtime: { state: { resolveStateDir: () => '/tmp/vauxr-restart-no-io' } } });
  const firstApi = api();
  await entry.register(firstApi);
  const first = globalThis.__vauxrRuntime;
  let stopped = 0;
  first.stop = () => { stopped++; };
  await entry.register(firstApi);
  assert.equal(globalThis.__vauxrRuntime, first, 'same registration retains runtime');
  assert.equal(stopped, 0);
  const nextApi = api();
  await entry.register(nextApi);
  const next = globalThis.__vauxrRuntime;
  assert.notEqual(next, first, 'restart must not retain old gateway capability');
  assert.equal(stopped, 1);
  assert.equal(next.isOwnedBy(nextApi), true);
  assert.equal(next.bridge.api, nextApi, 'voice dispatch uses current gateway API');
  assert.equal(next.origin, first.origin, 'enrollment store binding remains stable');
  assert.equal(next.wsUrl, first.wsUrl);
  delete globalThis.__vauxrRuntime;
});

test('gateway publishes actual states and abort stops service without status credentials', async () => {
  const states = []; let started = 0, stopped = 0;
  let state = 'pending';
  const runtime = { auth: { status: () => ({ state, userCode: 'ABCD1234' }) }, start() { started++; }, stop() { stopped++; } };
  globalThis.__vauxrRuntime = runtime;
  const abort = new AbortController();
  const task = vauxrPlugin.gateway.startAccount({ accountId: 'default', abortSignal: abort.signal, setStatus: value => states.push(value) });
  assert.equal(started, 1); assert.equal(states.at(-1).connected, false);
  state = 'connected'; runtime.auth.onStatus();
  assert.equal(states.at(-1).connected, true);
  abort.abort(); await task;
  assert.equal(stopped, 1); assert.equal(states.at(-1).running, false);
  assert.equal(JSON.stringify(states).includes('ABCD1234'), false);
  delete globalThis.__vauxrRuntime;
});

test('outbound text refuses to claim delivery without its originating voice turn', async () => {
  await assert.rejects(
    vauxrPlugin.outbound.sendText({ cfg: config(), to: 'device-1', text: 'orphaned progress' }),
    /No active Vauxr voice turn/,
  );
});

test('health-monitor restart resumes a retired bridge without re-pairing', async () => {
  const runtime = new VauxrRuntime({ runtime: { state: { resolveStateDir: () => '/tmp/vauxr-runtime-recovery' } } },
    { url: 'https://vauxr.example.test' });
  let refreshes = 0;
  runtime.running = true;
  runtime.bridge = { refresh: async () => { refreshes++; } };
  runtime.start();
  await Promise.resolve();
  assert.equal(refreshes, 1);
});

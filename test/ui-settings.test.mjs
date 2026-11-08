import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runChannelInboundEvent } from 'openclaw/plugin-sdk/channel-inbound';
import { recordInboundSession } from 'openclaw/plugin-sdk/conversation-runtime';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';
import { VauxrBridge } from '../dist/src/bridge.js';
import { registerTools } from '../dist/src/tools.js';

const source = process.env.VAUXR_UI_SOURCE;
const artifacts = process.env.VAUXR_TEST_ARTIFACTS;
test('registered SDK tools update settings through production Python HTTP and integration WS in one turn',
  { skip: source && artifacts ? false : 'Set VAUXR_UI_SOURCE and VAUXR_TEST_ARTIFACTS' }, async t => {
    const data = await mkdtemp(resolve(artifacts, 'ui-protocol-'));
    const priorState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = resolve(data, 'openclaw');
    const child = spawn(process.env.PYTHON ?? 'python3', ['-B', resolve('test/ui-server.py')], {
      cwd: source,
      env: { ...process.env, DATA_DIR: data, OPENCLAW_URL: '', OWNER_HTTPS_ORIGIN: '',
        OWNER_TRUSTED_PROXIES: '', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    let bridge;
    t.after(async () => { bridge?.stop(); if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } if (priorState === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = priorState; await rm(data, { recursive: true, force: true }); });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 10000);
      createInterface({ input: child.stdout }).once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Fixture exited: ${stderr}`)); });
    });
    const post = async (action, body, headers = ready.headers) => fetch(`${ready.origin}/api/companion/${action}`, {
      method: 'POST', headers, body: JSON.stringify({ browser_id: 'B1', ...body }),
    });
    const { chromium } = await import(resolve(source, 'e2e/node_modules/playwright/index.mjs'));
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const [cookieName, cookieValue] = ready.headers.Cookie.split('=');
    await page.context().addCookies([{ name: cookieName, value: cookieValue, url: ready.origin }]);
    await page.goto(ready.origin);
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: 'View agent Household', exact: true }).waitFor();
    const logs = [];
    const tools = new Map(); let state = 'disconnected', events, dispatches = 0, context, result;
    const api = { config: { agents: { list: [{ id: 'assistant', default: true }] },
      session: { store: resolve(data, 'sessions.json') } }, logger: { info() {}, warn(m) { logs.push(m); }, debug(m) { logs.push(m); } },
      registerTool(tool) { tools.set(tool.name, tool); }, runtime: { events: { onAgentEvent(fn) { events = fn; return () => {}; } }, channel: {
        session: { resolveStorePath, recordInboundSession },
        inbound: { async run(args) { try { return await runChannelInboundEvent(args); } catch (error) { logs.push(String(error.stack)); throw error; } } },
        reply: { createReplyDispatcherWithTyping() { return { dispatcher: {} }; },
          async dispatchReplyFromConfig(args) {
            dispatches++;
            args.replyOptions.onAgentRunStart('sdk-settings');
            const read = tools.get('vauxr_ui_context_read'), update = tools.get('vauxr_ui_agent_name_update');
            context = (await read.execute('read', {})).details;
            assert.equal(context.current_value, 'Household');
            assert.equal(JSON.stringify(context).includes('fixture-'), false);
            await assert.rejects(update.execute('wrong-target', { resource_id: 'wrong', new_value: 'Wrong' }));
            for (const value of ['', '\u200bhidden', '\u0085hidden', 'x'.repeat(121)]) {
              await assert.rejects(update.execute('invalid', { resource_id: context.resource_id, new_value: value }));
            }
            result = (await update.execute('update', { resource_id: context.resource_id, new_value: 'Kitchen helper' })).details;
            // Server has persisted before tool success, with no owner approval request.
            const agents = await (await fetch(`${ready.origin}/api/agents`, { headers: ready.headers })).json();
            assert.equal(agents.find(agent => agent.id === ready.subject).name, 'Kitchen helper');
            events({ runId: 'sdk-settings', stream: 'assistant', data: { delta: 'Saved Kitchen helper.' } });
            events({ runId: 'sdk-settings', stream: 'lifecycle', data: { phase: 'end' } });
          } },
      } } };
    registerTools(api, {});
    assert.equal(tools.has('vauxr_ui_agent_name_propose'), false);
    await assert.rejects(tools.get('vauxr_ui_context_read').execute('outside', {}));
    const auth = { async bearer() { return 'fixture-integration'; }, subject() { return ready.subject; },
      connected() { state = 'connected'; }, disconnected() { state = 'disconnected'; }, status() { return { state }; } };
    bridge = new VauxrBridge(api, { url: ready.origin }, auth); bridge.start();
    const deadline = Date.now() + 5000;
    while (state !== 'connected') { assert.ok(Date.now() < deadline, JSON.stringify(logs) + stderr); await new Promise(r => setTimeout(r, 10)); }
    const body = { route: 'agents', resource_type: 'agent', resource_id: ready.subject, setting_key: 'name', current_value: 'Household' };
    assert.equal((await post('context', body, { ...ready.headers, 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await post('context', body, { ...ready.headers, 'X-Vauxr-Browser': 'fixture-integration' })).status, 403);
    assert.equal((await post('context', body)).status, 200);
    await page.getByRole('button', { name: 'View agent Household', exact: true }).click();
    await page.getByRole('button', { name: 'Connect browser', exact: true }).click();
    await page.getByLabel('Conversation agent', { exact: true }).selectOption(ready.subject);
    await page.getByLabel('Display name', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Display name"]').disabled);
    await page.getByLabel('Text message', { exact: true }).fill('Rename the selected agent Kitchen helper');
    await page.getByRole('button', { name: 'Send text', exact: true }).click();
    await page.getByLabel('Agent text response', { exact: true }).filter({ hasText: 'Saved Kitchen helper.' }).waitFor();
    assert.equal(dispatches, 1);
    await page.getByText('Selected agent: Kitchen helper · Display name', { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: 'View agent Kitchen helper', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: 'View agent Kitchen helper', exact: true }).waitFor();
    assert.deepEqual(result, { resource_id: ready.subject, name: 'Kitchen helper' });
    for (const action of ['propose', 'confirm']) assert.equal((await post(action, {})).status, 404);
    assert.equal(stderr.includes('fixture-integration'), false);
  });

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RealtimeConversations } from '../dist/src/realtime.js';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

test('pinned SDK bootstraps selected profile and records without dispatch, with exact session ownership', async () => {
  const sdk = JSON.parse(await readFile(new URL('../node_modules/openclaw/package.json', import.meta.url), 'utf8'));
  assert.equal(sdk.version, '2026.9.4');
  const root = await mkdtemp(join(tmpdir(), 'vauxr70-realtime-'));
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    await writeFile(join(workspace, 'SOUL.md'), 'You are the selected kitchen assistant.');
    const cfg = { session: { store: join(root, 'sessions.json') }, agents: { list: [{ id: 'kitchen', workspace, default: true }] } };
    const conversations = new RealtimeConversations(cfg, 'kitchen');
    const bootstrap = await conversations.bootstrap('browser', 'session1');
    assert.match(bootstrap.instructions, /selected kitchen assistant/);
    assert.deepEqual(bootstrap.messages, []);
    const fragments = [{ id: 'u1', role: 'user', text: 'Remember the blue mug.' },
      { id: 'a1', role: 'assistant', text: 'The blue mug is', delivered: false }];
    await conversations.record('browser', 'session1', fragments);
    await conversations.record('browser', 'session1', fragments);
    const scope = conversations.scope('browser', 'session1');
    assert.equal(scope.sessionKey, 'agent:kitchen:vauxr:browser');
    const entries = await readVisibleSessionTranscriptMessageEntries(scope);
    assert.equal(entries.length, 2, 'retry must not duplicate transcript messages');
    assert.match(entries[1].message.content[0].text, /delivery unconfirmed/);
    assert.deepEqual(conversations.release('browser', 'session1'), { released: true });
    assert.throws(() => conversations.scope('browser', 'session1'), /session changed/);
    const resume = await conversations.bootstrap('browser', 'session2');
    assert.equal(resume.sessionId, bootstrap.sessionId);
    assert.equal(resume.messages.length, 2);
    assert.throws(() => conversations.scope('other-browser', 'session1'), /session changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('record protocol persists whole turns once; only a unique consultation dispatches a backend action', async () => {
  const { VauxrBridge } = await import('../dist/src/bridge.js');
  const { WebSocketServer } = await import('ws');
  const { once } = await import('node:events');
  const root = await mkdtemp(join(tmpdir(), 'vauxr70-record-'));
  const server = new WebSocketServer({host:'127.0.0.1', port:0});
  await once(server, 'listening');
  const config = {session:{store:join(root, 'sessions.json')}, agents:{list:[{id:'kitchen', workspace:root, default:true}]}};
  let emit, dispatches = 0, connected = false;
  const api = { config, logger:{debug(){}, info(){}, warn(){}, error(){}}, runtime:{
    events:{onAgentEvent(callback){emit = callback; return () => {}; }},
    channel:{
      session:{resolveStorePath(){return config.session.store;}, recordInboundSession(){}},
      inbound:{async run({adapter}){dispatches++; await adapter.resolveTurn().runDispatch();}},
      reply:{createReplyDispatcherWithTyping(){return {dispatcher:{}};},
        async dispatchReplyFromConfig({replyOptions}){
          replyOptions.onAgentRunStart('one-action');
          emit({runId:'one-action', stream:'assistant', data:{delta:'Action completed.'}});
        }},
    },
  }};
  const auth = {async bearer(){return 'local-test';}, subject(){return 'integration';},
    connected(){connected=true;}, disconnected(){connected=false;}, status(){return {state:connected?'connected':'disconnected'};}};
  const bridge = new VauxrBridge(api, {url:`http://127.0.0.1:${server.address().port}`}, auth);
  try {
    const accepted = once(server, 'connection');
    bridge.start();
    const [socket] = await accepted;
    const [raw] = await once(socket, 'message');
    assert.equal(JSON.parse(String(raw)).type, 'agent.auth');
    socket.send(JSON.stringify({type:'agent.ready', agentId:'integration'}));
    let sequence = 0;
    const request = async (operation, payload = {}, requestId = String(++sequence)) => {
      const response = once(socket, 'message', {signal:AbortSignal.timeout(5000)});
      socket.send(JSON.stringify({type:'agent.realtime.request', requestId, deviceId:'browser', session:'live-session', operation, payload}));
      const result = JSON.parse(String((await response)[0]));
      assert.equal(result.requestId, requestId);
      assert.equal(result.error, undefined);
      return result.result;
    };
    const bootstrap = await request('bootstrap');
    assert.deepEqual(bootstrap.messages, []);
    const fragments = [
      {id:'live-session-1', role:'user', text:'Turn on the lamp', delivered:false},
      {id:'live-session-2', role:'assistant', text:'I will check.', delivered:false},
      {id:'live-session-3', role:'assistant', text:'Working on', delivered:false},
      {id:'live-session-4', role:'user', text:'Actually, stop.', delivered:false},
    ];
    await request('record', {fragments:fragments.slice(0,2)});
    assert.equal(dispatches, 0, 'recording does not execute tools');
    const result = await request('consult', {request:'Consult the latest outstanding request.'}, 'one-consult');
    await request('record', {fragments:fragments.slice(2)}); // interruption is history, not another action
    await request('record', {fragments}); // retry with a new request ID still cannot duplicate history
    assert.deepEqual(await request('consult', {request:'Consult the latest outstanding request.'}, 'one-consult'), result);
    assert.equal(dispatches, 1);
    await request('release');
    const resumed = await request('bootstrap');
    assert.equal(resumed.sessionId, bootstrap.sessionId);
    assert.deepEqual(resumed.messages, fragments.map(f => ({role:f.role,
      content:f.role === 'assistant' ? `[Voice output; delivery unconfirmed] ${f.text}` : f.text})));
  } finally {
    bridge.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(root, {recursive:true, force:true});
  }
});

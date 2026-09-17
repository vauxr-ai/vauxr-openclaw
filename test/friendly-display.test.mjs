import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { runChannelInboundEvent } from 'openclaw/plugin-sdk/channel-inbound';
import { recordInboundSession } from 'openclaw/plugin-sdk/conversation-runtime';
import { resolveStorePath, upsertSessionEntry, getSessionEntry, loadSessionStore, sessionDeliveryOrigin } from 'openclaw/plugin-sdk/session-store-runtime';
// Test-only probe of the pinned 2026.9.3 gateway's actual sidebar projection.
// Production uses only the public MsgContext / inbound / session SDK contracts.
import { l as resolveGatewaySessionDisplayName } from '../node_modules/openclaw/dist/session-utils-list-Bk28ume-.mjs';
import { VauxrBridge } from '../dist/src/bridge.js';

const key = id => `agent:assistant:vauxr:${id}`;
const a = 'dev_' + 'a'.repeat(64), b = 'dev_' + 'b'.repeat(64);
const until = async predicate => {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fixture');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('authenticated production bridge persists friendly titles through the real OpenClaw inbound boundary', async t => {
  await mkdir('test-artifacts', { recursive: true });
  const root = await mkdtemp(resolve('test-artifacts/friendly-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storePath = resolve(root, 'agents/assistant/sessions/sessions.json');
  const history = id => resolve(root, `${id}.jsonl`);
  const historyBytes = id => JSON.stringify({role:'user',content:`existing history for ${id}`})+'\n';
  for (const id of [a,b]) await writeFile(history(id), historyBytes(id));
  for (const id of [a,b]) await upsertSessionEntry({ storePath, sessionKey:key(id), entry: {
    sessionId:`history-${id}`, updatedAt:1, sessionFile:history(id),
    delivery: { origin:{ provider:'vauxr', surface:'vauxr', from:id, label:id } },
  } });
  const entry = id => getSessionEntry({storePath, sessionKey:key(id)});
  const original = new Map([a,b].map(id => [id, entry(id)]));
  const warnings=[], contexts=[], responses=[], metaTasks=[], completions=[];
  const held = new Map();
  let holdDispatch = false;
  let eventHandler, socket, connections=0, sdkRun=0;
  const api = { config:{session:{store:storePath},agents:{list:[{id:'assistant',default:true}]}},
    logger:Object.fromEntries(['info','debug','warn'].map(level=>[level, msg=>{if(level==='warn')warnings.push(msg);} ])),
    runtime:{events:{onAgentEvent(fn){eventHandler=fn;return ()=>{};}},channel:{
      session:{resolveStorePath, recordInboundSession(params){
        return recordInboundSession({...params,trackSessionMetaTask:task=>metaTasks.push(task)});
      }},
      inbound:{async run(params){try{return await runChannelInboundEvent(params);}finally{completions.push(params.raw.deviceId);}}},
      reply:{createReplyDispatcherWithTyping(){return {dispatcher:{}};},async dispatchReplyFromConfig(args){
        contexts.push(args.ctx);
        const runId=`sdk-${++sdkRun}`;
        args.replyOptions.onAgentRunStart(runId);
        if (holdDispatch) await new Promise(resolve => held.set(args.ctx.SenderId, resolve));
        eventHandler({runId,stream:'assistant',data:{delta:`reply-${args.ctx.SenderId}`}});
        eventHandler({runId,stream:'lifecycle',data:{phase:'end'}});
      }},
    }} };
  let state='disconnected';
  const auth={async bearer(){return 'fixture-authority';},subject(){return 'int_fixture';},
    connected(){state='connected';},disconnected(){state='disconnected';},status(){return {state};}};
  const server=http.createServer();
  const wss=new WebSocketServer({server,path:'/agent'});
  wss.on('connection',ws=>{socket=ws;connections++;ws.on('message',bytes=>{
    const frame=JSON.parse(String(bytes));
    if(frame.type==='agent.auth') {
      assert.equal(frame.token,'fixture-authority');
      ws.send(JSON.stringify({type:'agent.transcript',deviceId:a,text:'ignored before ready',deviceDisplayName:'Untrusted early title'}));
      ws.send(JSON.stringify({type:'agent.ready',agentId:'int_fixture'}));
    } else responses.push(frame);
  });});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const bridge=new VauxrBridge(api,{url:`http://127.0.0.1:${server.address().port}`},auth);
  t.after(async()=>{bridge.stop();for(const ws of wss.clients)ws.terminate();wss.close();await new Promise(resolve=>server.close(resolve));});
  bridge.start();await until(()=>state==='connected');
  assert.equal(contexts.length,0);
  const send = async (id, extra={}) => {
    const count=completions.length;
    socket.send(JSON.stringify({type:'agent.transcript',deviceId:id,sessionKey:'vauxr:WRONG',text:'hello',...extra}));
    await until(()=>completions.length===count+1);
    await Promise.all(metaTasks.splice(0));
    assert.deepEqual(warnings,[]);
  };
  const title = (id, expected) => {
    const row=entry(id);
    assert.equal(sessionDeliveryOrigin(row).label,expected);
    assert.equal(resolveGatewaySessionDisplayName(key(id),row),expected);
    assert.equal(row.sessionId,original.get(id).sessionId);
    assert.equal(row.sessionFile,original.get(id).sessionFile);
    assert.equal(sessionDeliveryOrigin(row).from,id);
  };
  await send(a);title(a,a);
  await send(a,{deviceDisplayName:'  Living Room  ',name:'raw hello impostor'});title(a,'Living Room');
  await send(a,{deviceDisplayName:'Office'});title(a,'Office');
  socket.close();await until(()=>state==='disconnected');
  await until(()=>connections===2&&state==='connected');
  // Server repeats its current stored name on every transcript, including reconnect.
  await send(a,{deviceDisplayName:'Office'});title(a,'Office');
  await send(b,{deviceDisplayName:'Office'});title(b,'Office');title(a,'Office');
  for(const deviceDisplayName of [undefined,null,42,{},[],true,'','   ','x'.repeat(129),'Room\nFake','Room\u202eFake']) {
    await send(b,{deviceDisplayName,name:'untrusted legacy label'});title(b,b);title(a,'Office');
  }
  await send(b,{deviceDisplayName:'Kitchen'});title(b,'Kitchen');title(a,'Office');
  await until(()=>responses.length===contexts.length*2);
  const protocolRuns=new Set();
  for(let i=0;i<contexts.length;i++) {
    const ctx=contexts[i];
    assert.equal(ctx.SessionKey,key(ctx.SenderId));
    assert.equal(ctx.From,ctx.SenderId);assert.equal(ctx.SenderName,ctx.SenderId);
    const [delta,end]=responses.slice(i*2,i*2+2);
    assert.equal(delta.deviceId,ctx.SenderId);assert.equal(end.deviceId,ctx.SenderId);
    assert.equal(delta.text,`reply-${ctx.SenderId}`);
    assert.equal(delta.type,'agent.response.delta');assert.equal(end.type,'agent.response.end');
    assert.equal(delta.runId,end.runId);assert.ok(!protocolRuns.has(delta.runId));protocolRuns.add(delta.runId);
  }
  // Both duplicate-named devices have active turns at once; finish in reverse
  // order so a label-keyed route or shared correlation slot cannot pass.
  holdDispatch=true;
  const responseStart=responses.length, contextStart=contexts.length;
  for(const id of [a,b]) socket.send(JSON.stringify({type:'agent.transcript',deviceId:id,text:'overlap',deviceDisplayName:'Shared Room'}));
  await until(()=>held.size===2);
  await Promise.all(metaTasks.splice(0));
  title(a,'Shared Room');title(b,'Shared Room');
  assert.equal(bridge.activeRuns.size,2);
  held.get(b)();await until(()=>responses.length===responseStart+2);
  held.get(a)();await until(()=>responses.length===responseStart+4);
  const overlap=responses.slice(responseStart);
  assert.deepEqual(overlap.map(frame=>frame.deviceId),[b,b,a,a]);
  assert.equal(overlap[0].runId,overlap[1].runId);
  assert.equal(overlap[2].runId,overlap[3].runId);
  assert.notEqual(overlap[0].runId,overlap[2].runId);
  assert.equal(overlap[0].text,`reply-${b}`);assert.equal(overlap[2].text,`reply-${a}`);
  assert.deepEqual(contexts.slice(contextStart).map(ctx=>ctx.SessionKey),[key(a),key(b)]);
  assert.deepEqual(Object.keys(loadSessionStore(storePath)).sort(),[key(a),key(b)].sort());
  for (const id of [a,b]) assert.equal(await readFile(history(id),'utf8'),historyBytes(id));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { VauxrBridge } from '../dist/src/bridge.js';
import { runChannelInboundEvent } from 'openclaw/plugin-sdk/channel-inbound';
import { recordInboundSession } from 'openclaw/plugin-sdk/conversation-runtime';
import { getSessionEntry, resolveStorePath, sessionDeliveryOrigin } from 'openclaw/plugin-sdk/session-store-runtime';
import { l as resolveGatewaySessionDisplayName } from '../node_modules/openclaw/dist/session-utils-list-RGkE30m3.mjs';

test('production realtime inbound/session path uses Standard identity and current validated titles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vauxr-live-title-'));
  const server = new WebSocketServer({host:'127.0.0.1', port:0});
  await once(server, 'listening');
  const storePath = join(root, 'sessions.json');
  const config = {session:{store:storePath}, agents:{list:[{id:'assistant', workspace:root, default:true}]}};
  const contexts = [], tasks = [];
  let emit;
  const api = {config, logger:{info(){}, debug(){}, warn(){}, error(){}}, runtime:{
    events:{onAgentEvent(fn){emit=fn; return () => {}; }}, channel:{
      session:{resolveStorePath, recordInboundSession(params){
        return recordInboundSession({...params, trackSessionMetaTask:task=>tasks.push(task)});
      }},
      inbound:{run:runChannelInboundEvent},
      reply:{createReplyDispatcherWithTyping(){return {dispatcher:{}};}, async dispatchReplyFromConfig({ctx,replyOptions}){
        contexts.push(ctx); replyOptions.onAgentRunStart('run-'+contexts.length);
        emit({runId:'run-'+contexts.length, stream:'assistant', data:{delta:'done'}});
      }},
    },
  }};
  const auth={async bearer(){return 'local-fixture';}, subject(){return 'integration';},
    connected(){}, disconnected(){}, status(){return {state:'connected'};}};
  const bridge=new VauxrBridge(api,{url:`http://127.0.0.1:${server.address().port}`},auth);
  const a='dev_'+'a'.repeat(64), b='dev_'+'b'.repeat(64);
  const key=id=>`agent:assistant:vauxr:${id}`;
  const entry=id=>getSessionEntry({storePath,sessionKey:key(id)});
  let socket, sequence=0;
  async function connected(promise) {
    [socket]=await promise;
    assert.equal(JSON.parse(String((await once(socket,'message'))[0])).type,'agent.auth');
    socket.send(JSON.stringify({type:'agent.ready',agentId:'integration'}));
  }
  async function request(id, operation, name, session='scope', payload={}) {
    const requestId=String(++sequence);
    const response=once(socket,'message',{signal:AbortSignal.timeout(5000)});
    socket.send(JSON.stringify({type:'agent.realtime.request',deviceId:id,requestId,session,operation,payload,
      deviceDisplayName:name,name:'Raw hello impostor',sessionKey:key('WRONG')}));
    const result=JSON.parse(String((await response)[0]));
    assert.equal(result.deviceId,id); assert.equal(result.requestId,requestId);
    await Promise.all(tasks.splice(0));
    return result;
  }
  function title(id, label, sessionId) {
    const row=entry(id);
    assert.equal(sessionDeliveryOrigin(row).label,label);
    assert.equal(sessionDeliveryOrigin(row).from,id);
    assert.equal(resolveGatewaySessionDisplayName(key(id),row),label === id ? undefined : label);
    if(sessionId) assert.equal(row.sessionId,sessionId);
  }
  try {
    const accepted=once(server,'connection'); bridge.start(); await connected(accepted);
    const first=await request(a,'bootstrap',' web-client ');
    assert.equal(first.error,undefined);
    const sessionId=first.result.sessionId;
    title(a,'web-client',sessionId); assert.equal(contexts.length,0);
    await request(a,'record','Renamed','scope',{fragments:[]}); title(a,'Renamed',sessionId);
    await request(a,'consult','Shared','scope',{request:'Check the latest request'});
    title(a,'Shared',sessionId);
    const ctx=contexts.at(-1);
    assert.equal(ctx.ConversationLabel,'Shared'); assert.equal(ctx.SenderName,a);
    assert.equal(ctx.From,a); assert.equal(ctx.SenderId,a); assert.equal(ctx.SessionKey,key(a));
    await request(b,'bootstrap','Shared'); title(b,'Shared'); title(a,'Shared',sessionId);
    assert.notEqual(entry(b).sessionId,sessionId);
    const rejected=await request(b,'record','Wrong','unowned-scope',{fragments:[]});
    assert.ok(rejected.error); title(b,'Shared'); title(a,'Shared',sessionId);
    for(const name of [undefined,null,42,{},[],true,'',' ','x'.repeat(129),'😀'.repeat(65),'Room\nFake','Room\u202eFake']) {
      await request(a,'record',name,'scope',{fragments:[]}); title(a,a,sessionId);
    }
    // Standard dispatch sees the very same row/session and context identity.
    const response=once(socket,'message',{signal:AbortSignal.timeout(5000)});
    socket.send(JSON.stringify({type:'agent.transcript',deviceId:a,text:'standard',deviceDisplayName:'Standard'}));
    await response;
    while(contexts.length<2 || bridge.activeRuns.size) await new Promise(r=>setTimeout(r,5));
    await Promise.all(tasks.splice(0)); title(a,'Standard',sessionId);
    assert.equal(contexts.at(-1).SessionKey,ctx.SessionKey);
    const reconnect=once(server,'connection',{signal:AbortSignal.timeout(10000)});
    socket.close(); await connected(reconnect);
    const resumed=await request(a,'bootstrap','Reconnected','fresh');
    assert.equal(resumed.result.sessionId,sessionId); title(a,'Reconnected',sessionId);
  } finally {
    bridge.stop(); for(const ws of server.clients) ws.terminate();
    await new Promise(resolve=>server.close(resolve)); await rm(root,{recursive:true,force:true});
  }
});

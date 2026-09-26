import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { VauxrBridge } from '../dist/src/bridge.js';
import { vauxrPlugin } from '../dist/src/channel.js';
import { requestJson, endpoints } from '../dist/src/transport.js';

const run = promisify(execFile);
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check) {
  const deadline=Date.now()+4000;
  while(!check()) {if(Date.now()>=deadline) throw new Error('Timed out waiting for local test state');await delay(5);}
}
async function listen(t, server) {
  const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{for(const socket of sockets)socket.destroy();server.closeAllConnections?.();server.close(resolve);}));
  return `${server instanceof https.Server?'https':'http'}://127.0.0.1:${server.address().port}`;
}
function harness(origin) {
  const logs=[];let connected=0,disconnected=0,rejected=0;let token='initial-test-authority';
  const state={value:'disconnected'};
  const api={config:{},logger:Object.fromEntries(['info','warn','error','debug'].map(level=>[level,(...args)=>logs.push(args.join(' '))])),runtime:{events:{onAgentEvent(){return ()=>{};}},channel:{}}};
  const auth={status(){return {state:state.value};},subject(){return 'int_test';},async tick(){rejected++;state.value='re_pair_required';},async bearer(){return token;},connected(){connected++;state.value='connected';},disconnected(){disconnected++;state.value='disconnected';},async rejected(){rejected++;state.value='re_pair_required';}};
  const bridge=new VauxrBridge(api,{url:origin},auth);
  return {bridge,logs,state,rotate(){token='rotated-test-authority';},counts:()=>({connected,disconnected,rejected})};
}
async function wsFixture(t, handler) {
  const server=http.createServer();
  const origin=await listen(t,server);
  const wss=new WebSocketServer({server});
  wss.on('connection',handler);
  t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();});
  return origin;
}

test('HTTP never follows redirect or forwards auth/body to redirect destination; remote errors stay generic',async t=>{
  let forwarded=0;
  const destination=await listen(t,http.createServer((req,res)=>{forwarded++;res.end('{}');}));
  const source=await listen(t,http.createServer((req,res)=>{
    assert.equal(req.headers.cookie,undefined);
    res.writeHead(req.url.endsWith('/redirect')?307:403,{Location:`${destination}/api/capture`,'Content-Type':'application/json'});
    res.end(JSON.stringify({error:'server-injected-sensitive-sentinel',credential:'server-injected-sensitive-sentinel'}));
  }));
  await assert.rejects(requestJson(source,'/api/redirect',{private:'body-test-sentinel'},'authority-test-sentinel'),error=>error.code==='redirect_refused'&&!String(error).includes('sentinel'));
  await assert.rejects(requestJson(source,'/api/denied',{},'authority-test-sentinel'),error=>error.code==='operation_denied'&&!String(error).includes('sentinel'));
  assert.equal(forwarded,0);
});

test('WS refuses redirect before agent authentication and never reports connected',async t=>{
  let forwarded=0;
  const destination=await listen(t,http.createServer((req,res)=>{forwarded++;res.end();}));
  const source=await listen(t,http.createServer((req,res)=>{res.writeHead(302,{Location:destination.replace('http:','ws:')+'/agent'});res.end();}));
  const h=harness(source);t.after(()=>h.bridge.stop());h.bridge.start();
  await until(()=>h.logs.some(line=>line.includes('connection failed')));
  assert.equal(forwarded,0);assert.equal(h.counts().connected,0);assert.equal(h.state.value,'disconnected');
});

test('real WS waits for ready, ignores early transcripts, sanitizes frames/errors and clears turns on disconnect',async t=>{
  let socket,gotAuth=false,dispatched=0;
  const origin=await wsFixture(t,ws=>{socket=ws;ws.on('message',data=>{const frame=JSON.parse(String(data));if(frame.type==='agent.auth')gotAuth=true;});});
  const h=harness(origin);t.after(()=>h.bridge.stop());
  h.bridge.dispatchTranscript=async()=>{dispatched++;};
  h.bridge.start();await until(()=>gotAuth);
  assert.equal(h.counts().connected,0);
  socket.send(JSON.stringify({type:'agent.transcript',deviceId:'dev-test',text:'before-auth'}));
  await delay(20);assert.equal(dispatched,0);
  socket.send(JSON.stringify({type:'agent.ready',agentId:'int_test'}));await until(()=>h.counts().connected===1);
  socket.send('invalid-frame-secret-sentinel');
  socket.send(JSON.stringify({type:'unknown-secret-sentinel',message:'error-secret-sentinel'}));
  socket.send(JSON.stringify({type:'error',code:'unknown-secret-sentinel',message:'error-secret-sentinel'}));
  socket.send(JSON.stringify({type:'agent.device_state',deviceId:'device-secret-sentinel',state:'state-secret-sentinel'}));
  socket.send(JSON.stringify({type:'agent.transcript',deviceId:'dev-test',text:'after-auth'}));
  await until(()=>dispatched===1);
  h.bridge.activeRuns.set('dev-test',{deviceId:'dev-test',protocolRunId:'run'});
  h.bridge.runIdToTurn.set('run',{deviceId:'dev-test',protocolRunId:'run'});
  socket.close(1000,'close-secret-sentinel');await until(()=>h.state.value==='disconnected');
  assert.equal(h.bridge.activeRuns.size,0);assert.equal(h.bridge.runIdToTurn.size,0);
  assert.ok(!h.logs.join('\n').includes('secret-sentinel'));
});

test('message-tool progress is spoken before the final assistant response',async t=>{
  let socket,emit;
  const responses=[];
  const origin=await wsFixture(t,ws=>{
    socket=ws;
    ws.on('message',data=>{
      const frame=JSON.parse(String(data));
      if(frame.type==='agent.auth')ws.send(JSON.stringify({type:'agent.ready',agentId:'int_test'}));
      else responses.push(frame);
    });
  });
  const h=harness(origin);t.after(()=>h.bridge.stop());
  h.bridge.api.runtime.events.onAgentEvent=callback=>{emit=callback;return()=>{};};
  h.bridge.api.runtime.channel={
    session:{resolveStorePath(){return '/unused';},recordInboundSession(){}},
    inbound:{async run({adapter}){await adapter.resolveTurn().runDispatch();}},
    reply:{
      createReplyDispatcherWithTyping(){return{dispatcher:{}};},
      async dispatchReplyFromConfig({replyOptions}){
        replyOptions.onAgentRunStart('sdk-progress-run');
        const delivered=await vauxrPlugin.outbound.sendText({cfg:{},to:'dev-test',text:'I am checking that now.'});
        assert.match(delivered.messageId,/^[0-9a-f-]{36}:1$/);
        await assert.rejects(
          vauxrPlugin.outbound.sendText({cfg:{},to:'another-device',text:'must not leak'}),
          /no longer available/,
        );
        emit({runId:'sdk-progress-run',stream:'assistant',data:{delta:'The check is complete.'}});
        emit({runId:'sdk-progress-run',stream:'lifecycle',data:{phase:'end'}});
      },
    },
  };
  h.bridge.start();await until(()=>h.bridge.authenticated);
  socket.send(JSON.stringify({type:'agent.transcript',deviceId:'dev-test',text:'Please check'}));
  await until(()=>responses.some(frame=>frame.type==='agent.response.end'));
  const runId=responses[0].runId;
  assert.deepEqual(responses,[
    {type:'agent.response.delta',deviceId:'dev-test',runId,text:'I am checking that now.'},
    {type:'agent.response.delta',deviceId:'dev-test',runId,text:'The check is complete.'},
    {type:'agent.response.end',deviceId:'dev-test',runId},
  ]);
});

test('native commentary preamble is spoken once before the final assistant response',async t=>{
  let socket,emit;
  const responses=[];
  const origin=await wsFixture(t,ws=>{
    socket=ws;
    ws.on('message',data=>{
      const frame=JSON.parse(String(data));
      if(frame.type==='agent.auth')ws.send(JSON.stringify({type:'agent.ready',agentId:'int_test'}));
      else responses.push(frame);
    });
  });
  const h=harness(origin);t.after(()=>h.bridge.stop());
  h.bridge.api.runtime.events.onAgentEvent=callback=>{emit=callback;return()=>{};};
  h.bridge.api.runtime.channel={
    session:{resolveStorePath(){return '/unused';},recordInboundSession(){}},
    inbound:{async run({adapter}){await adapter.resolveTurn().runDispatch();}},
    reply:{
      createReplyDispatcherWithTyping(){return{dispatcher:{}};},
      async dispatchReplyFromConfig({replyOptions}){
        replyOptions.onAgentRunStart('sdk-commentary-run');
        emit({runId:'sdk-commentary-run',stream:'item',data:{kind:'preamble',title:'Preamble',phase:'update',progressText:'I am checking',itemId:'commentary-1'}});
        emit({runId:'sdk-commentary-run',stream:'item',data:{kind:'preamble',title:'Preamble',phase:'end',progressText:'I am checking that now.',itemId:'commentary-1'}});
        emit({runId:'sdk-commentary-run',stream:'item',data:{kind:'preamble',title:'Preamble',phase:'end',progressText:'I am checking that now.',itemId:'commentary-1'}});
        emit({runId:'sdk-commentary-run',stream:'assistant',data:{delta:'The check is complete.'}});
        emit({runId:'sdk-commentary-run',stream:'lifecycle',data:{phase:'end'}});
      },
    },
  };
  h.bridge.start();await until(()=>h.bridge.authenticated);
  socket.send(JSON.stringify({type:'agent.transcript',deviceId:'dev-test',text:'Please check'}));
  await until(()=>responses.some(frame=>frame.type==='agent.response.end'));
  const runId=responses[0].runId;
  assert.deepEqual(responses,[
    {type:'agent.response.delta',deviceId:'dev-test',runId,text:'I am checking that now.'},
    {type:'agent.response.delta',deviceId:'dev-test',runId,text:'The check is complete.'},
    {type:'agent.response.end',deviceId:'dev-test',runId},
  ]);
});

test('rotation reconnects using replacement and ready gates new connection; revoked stops retries explicitly',async t=>{
  const sockets=[],authorities=[];
  const origin=await wsFixture(t,ws=>{sockets.push(ws);ws.on('message',data=>{const frame=JSON.parse(String(data));if(frame.type==='agent.auth')authorities.push(frame.token);});});
  const h=harness(origin);t.after(()=>h.bridge.stop());h.bridge.start();
  await until(()=>authorities.length===1);sockets[0].send(JSON.stringify({type:'agent.ready',agentId:'int_test'}));await until(()=>h.state.value==='connected');
  h.rotate();await h.bridge.refresh();await until(()=>authorities.length===2);
  assert.notEqual(authorities[0],authorities[1]);assert.equal(h.state.value,'disconnected');
  sockets[1].send(JSON.stringify({type:'agent.ready',agentId:'int_test'}));await until(()=>h.counts().connected===2);
  sockets[1].send(JSON.stringify({type:'error',code:'UNAUTHORIZED',message:'revoked-secret-sentinel'}));await until(()=>h.counts().rejected===1);
  assert.equal(h.state.value,'re_pair_required');assert.equal(h.bridge.started,false);assert.equal(h.bridge.reconnectTimer,null);
  assert.ok(!h.logs.join('\n').includes('secret-sentinel'));
});

function certificates(t) {
  const dir=mkdtempSync(join(process.cwd(),'test/.transport-certs-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const openssl=args=>execFileSync('openssl',args,{cwd:dir,stdio:'pipe'});
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','2','-subj','/CN=Vauxr test CA','-addext','basicConstraints=critical,CA:TRUE']);
  for(const [name,san,days] of [['trusted','IP:127.0.0.1','1'],['wrong-san','DNS:wrong.invalid','1'],['expired','IP:127.0.0.1','-1']]) {
    openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',`${name}.key`,'-out',`${name}.csr`,'-subj','/CN=Vauxr test endpoint']);
    writeFileSync(join(dir,`${name}.ext`),`subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
    openssl(['x509','-req','-in',`${name}.csr`,'-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',`${name}.pem`,'-days',days,'-extfile',`${name}.ext`]);
  }
  return {dir, options:name=>({key:readFileSync(join(dir,`${name}.key`)),cert:readFileSync(join(dir,`${name}.pem`))})};
}
// Runtime boundary only: the bridge's transcript adapter, event correlation and
// response sender remain production code. No live gateway/model is needed.
const childCode=`
import assert from 'node:assert/strict';
import {requestJson} from './dist/src/transport.js';
import {VauxrBridge} from './dist/src/bridge.js';
let connected=false,processed=0,emit;const logs=[],warnings=[];
const api={config:{channels:{vauxr:{targetAgent:'tls-agent'}}},
  logger:Object.fromEntries(['debug','info','warn','error'].map(level=>[level,m=>{logs.push(m);if(level==='warn'||level==='error')warnings.push(m);} ])),
  runtime:{events:{onAgentEvent(callback){emit=callback;return ()=>{};}},channel:{
    session:{resolveStorePath(){return '/unused';},recordInboundSession(){}},
    inbound:{async run({channel,raw,adapter}){
      assert.equal(channel,'vauxr');
      assert.deepEqual(raw,{deviceId:'tls-device',text:'post-ready'});
      assert.equal(adapter.ingest().rawText,'post-ready');
      assert.equal(adapter.classify().canStartAgentTurn,true);
      const turn=adapter.resolveTurn();
      assert.equal(turn.routeSessionKey,'agent:tls-agent:vauxr:tls-device');
      await turn.runDispatch();processed++;
    }},
    reply:{createReplyDispatcherWithTyping(){return {dispatcher:{}};},
      async dispatchReplyFromConfig({ctx,replyOptions}){
        assert.equal(ctx.Body,'post-ready');assert.equal(ctx.From,'tls-device');
        assert.equal(replyOptions.sourceReplyDeliveryMode,'automatic');
        const runId='tls-sdk-run';replyOptions.onAgentRunStart(runId);
        emit({runId,stream:'assistant',data:{delta:'TLS response'}});
        emit({runId,stream:'lifecycle',data:{phase:'end'}});
      }},
  }}};
const auth={status(){return {state:connected?'connected':'disconnected'};},subject(){return process.env.TEST_SUBJECT;},async tick(){},async bearer(){return process.env.TEST_TOKEN;},connected(){connected=true;},disconnected(){},async rejected(){}};
let http=false;try{http=(await requestJson(process.env.TEST_ORIGIN,'/api/check',{},process.env.TEST_TOKEN)).ok===true;}catch(error){logs.push(String(error));}
const bridge=new VauxrBridge(api,{url:process.env.TEST_ORIGIN,strictTls:true},auth);
bridge.start();
const deadline=Date.now()+3000;
while(processed!==1&&bridge.started&&!logs.some(x=>x.includes('connection failed'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
assert.ok(processed===1||!bridge.started||logs.some(x=>x.includes('connection failed')),'TLS child reached a terminal outcome');
const authenticated=bridge.authenticated;bridge.stop();console.log(JSON.stringify({http,connected,authenticated,processed,logs,warnings}));
`;

// Equivalent to the exercised contract in server 4155222a24316478675e54764cd7fed73fa04145:
// agent_server.py _handle_auth authenticates the bearer, requires AGENT_CONNECT,
// looks up the principal's registered agent, and derives ready.agentId from it.
// _handle_authenticated_message requires VOICE_RESPONSE, the active Agent and
// listener origin, and string deviceId/runId. Lifecycle/revocation is covered by
// the separate pinned real-server suite, not simulated by this static fixture.
function validatingAgentFixture(t, server) {
  const credentials=new Map([
    ['tls-test-authority',{role:'integration',subject:'int_test'}],
    ['tls-other-authority',{role:'integration',subject:'int_other'}],
    ['tls-unregistered-authority',{role:'integration',subject:'int_unregistered'}],
    ['tls-owner-authority',{role:'owner',subject:'int_test'}],
  ]);
  const agents=new Set(['int_test','int_other']);
  const state={authFrames:0,missingToken:false,ready:[],denials:[],responses:[],warnings:[],closed:0};
  const authenticate=token=>credentials.get(token);
  const allowed=(principal,operation)=>principal?.role==='integration'&&['agent.connect','voice.respond'].includes(operation);
  const wss=new WebSocketServer({server,path:'/agent'});
  wss.on('connection',ws=>{
    let principal,agent;
    const deny=code=>{state.denials.push(code);ws.send(JSON.stringify({type:'error',code,message:'Access denied'}));ws.close();};
    ws.on('close',()=>state.closed++);
    ws.on('error',()=>state.warnings.push('Unexpected fixture socket error'));
    ws.on('message',data=>{
      try {
        const frame=JSON.parse(String(data));
        if(!principal){
          assert.equal(frame.type,'agent.auth');state.authFrames++;
          state.missingToken=!Object.hasOwn(frame,'token');
          const candidate=authenticate(frame.token);
          if(!candidate){deny('UNAUTHORIZED');return;}
          if(!allowed(candidate,'agent.connect')||!agents.has(candidate.subject)){deny('FORBIDDEN');return;}
          principal=candidate;agent=principal.subject;state.ready.push(agent);
          ws.send(JSON.stringify({type:'agent.ready',agentId:agent}));
          // Deliberately queued even for a client with a mismatched local subject:
          // the bridge must reject ready and must not dispatch the following frame.
          ws.send(JSON.stringify({type:'agent.transcript',deviceId:'tls-device',text:'post-ready'}));
          return;
        }
        if(!allowed(principal,'voice.respond')||principal.subject!==agent||agent!=='int_test'){
          deny('FORBIDDEN');return;
        }
        assert.ok(['agent.response.delta','agent.response.end'].includes(frame.type),'Unexpected response frame');
        assert.equal(frame.deviceId,'tls-device'); // listener belongs to int_test
        assert.equal(typeof frame.runId,'string');assert.ok(frame.runId.length>0);
        state.responses.push(frame);
      } catch {
        // Never echo incoming frames, credentials, or assertion payloads.
        state.warnings.push('Unexpected fixture frame/handler failure');ws.close();
      }
    });
  });
  t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();});
  return {state,authenticate};
}

test('actual HTTPS and WSS validate TLS, agent authentication and production response dispatch',async t=>{
  const certs=certificates(t);
  const cases=[
    {label:'trusted TLS correlated response'},
    {label:'untrusted root',trust:false,tls:false},
    {label:'wrong SAN',certificate:'wrong-san',tls:false},
    {label:'expired certificate',certificate:'expired',tls:false},
    {label:'wrong token',token:'tls-invalid-authority',denial:'UNAUTHORIZED'},
    {label:'missing token',token:undefined,denial:'UNAUTHORIZED'},
    {label:'token without AGENT_CONNECT',token:'tls-owner-authority',denial:'FORBIDDEN'},
    {label:'unregistered agent identity',token:'tls-unregistered-authority',denial:'FORBIDDEN'},
    {label:'authenticated agent differs from local identity',token:'tls-other-authority',identityMismatch:true},
  ];
  for(const scenario of cases) await t.test(scenario.label,async t=>{
    const {certificate='trusted',trust=true,tls=true,denial,identityMismatch=false}=scenario;
    const token=Object.hasOwn(scenario,'token')?scenario.token:'tls-test-authority';
    const expected=tls&&!denial&&!identityMismatch;
    let httpCalls=0;
    const server=https.createServer(certs.options(certificate),(req,res)=>{
      httpCalls++;
      const header=req.headers.authorization;
      const principal=fixture.authenticate(header?.startsWith('Bearer ')?header.slice(7):undefined);
      res.writeHead(principal?200:401,{'Content-Type':'application/json'});
      res.end(JSON.stringify(principal?{ok:true}:{error:'unauthorized'}));
    });
    const fixture=validatingAgentFixture(t,server);
    const origin=await listen(t,server);
    const env={...process.env,TEST_ORIGIN:origin,TEST_SUBJECT:'int_test'};
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;delete env.NODE_EXTRA_CA_CERTS;delete env.TEST_TOKEN;
    if(token!==undefined)env.TEST_TOKEN=token;
    if(trust)env.NODE_EXTRA_CA_CERTS=join(certs.dir,'ca.pem');
    const result=await run(process.execPath,['--input-type=module','-e',childCode],{cwd:process.cwd(),env,timeout:8000});
    assert.equal(result.stderr,'','Unexpected child warning/error');
    const actual=JSON.parse(result.stdout);
    const state=fixture.state;
    if(tls)await until(()=>state.closed===1);
    assert.equal(actual.http,tls&&Boolean(fixture.authenticate(token)));
    assert.equal(actual.connected,expected);
    assert.equal(actual.authenticated,expected);
    assert.equal(actual.processed,expected?1:0);
    assert.deepEqual(actual.warnings,!tls?['[vauxr-bridge] WebSocket connection failed']:denial?['[vauxr-bridge] Server rejected Agent operation']:[]);
    assert.deepEqual(state.warnings,[]);
    assert.equal(httpCalls,tls?1:0);assert.equal(state.authFrames,tls?1:0);
    assert.equal(state.missingToken,tls&&token===undefined);
    assert.deepEqual(state.denials,denial?[denial]:[]);
    assert.deepEqual(state.ready,!tls||denial?[]:[identityMismatch?'int_other':'int_test']);
    if(expected){
      assert.equal(state.responses.length,2);
      const [delta,end]=state.responses;
      assert.match(delta.runId,/^[0-9a-f-]{36}$/);
      assert.notEqual(delta.runId,'tls-sdk-run');
      assert.deepEqual(delta,{type:'agent.response.delta',deviceId:'tls-device',runId:delta.runId,text:'TLS response'});
      assert.deepEqual(end,{type:'agent.response.end',deviceId:'tls-device',runId:delta.runId});
    }else assert.deepEqual(state.responses,[]);
    assert.ok(!JSON.stringify(actual).includes('authority'),'Credential must not appear in logs');
  });
});

test('origin binding rejects mixed schemes, hosts, URL credentials and strict LAN downgrade',()=>{
  for(const config of [{url:'wss://localhost:8443',httpUrl:'http://localhost:8080'},{url:'ws://localhost:8765',httpUrl:'http://other.invalid:8080'},{url:'ws://user:password@localhost:8765'},{url:'ws://localhost:8765',strictTls:true}])assert.throws(()=>endpoints(config));
  assert.deepEqual(endpoints({url:'http://localhost:8765'}),{origin:'http://localhost:8080',wsUrl:'ws://localhost:8765/agent'});
});

test('a retired voice turn cannot send errors through the replacement authenticated socket',async t=>{
  let connections=0,rejectDispatch,onSkipped;
  const responses=[];
  const origin=await wsFixture(t,ws=>{
    connections++;
    ws.on('message',data=>{
      const frame=JSON.parse(String(data));
      if(frame.type==='agent.auth')ws.send(JSON.stringify({type:'agent.ready',agentId:'int_test'}));
      else responses.push(frame);
    });
    if(connections===1)setTimeout(()=>ws.send(JSON.stringify({type:'agent.transcript',deviceId:'dev-test',text:'Start a voice turn'})),15);
  });
  const h=harness(origin);t.after(()=>h.bridge.stop());
  h.bridge.api.runtime.channel={
    session:{resolveStorePath(){return '/unused';},recordInboundSession(){}},
    inbound:{run({adapter}){onSkipped=adapter.resolveTurn().runDispatchLifecycle.onDispatchSkipped;return new Promise((resolve,reject)=>{rejectDispatch=reject;});}},
  };
  h.bridge.start();await until(()=>Boolean(rejectDispatch));
  h.rotate();await h.bridge.refresh();await until(()=>h.counts().connected===2);
  onSkipped('retired-turn-sensitive-sentinel');
  rejectDispatch(new Error('retired-turn-sensitive-sentinel'));
  await delay(25);
  assert.deepEqual(responses,[]);
  assert.ok(!h.logs.join('\n').includes('sensitive-sentinel'));
});

test('ready for another agent cannot mark the integration connected',async t=>{
  const origin=await wsFixture(t,ws=>ws.on('message',()=>ws.send(JSON.stringify({type:'agent.ready',agentId:'int_someone_else'}))));
  const h=harness(origin);t.after(()=>h.bridge.stop());h.bridge.start();
  await until(()=>!h.bridge.started);
  assert.equal(h.counts().connected,0);assert.equal(h.state.value,'disconnected');
});

for (const replacement of ['stop/start', 'socket close']) {
  test(`unresolved old dispatch permits a new turn after ${replacement} and stays isolated`, async t => {
    const sockets = [], responses = [], pending = [];
    let emit;
    const origin = await wsFixture(t, ws => {
      sockets.push(ws);
      ws.on('message', data => {
        const frame = JSON.parse(String(data));
        if (frame.type === 'agent.auth') ws.send(JSON.stringify({type:'agent.ready',agentId:'int_test'}));
        else responses.push(frame);
      });
    });
    const h = harness(origin);
    t.after(() => h.bridge.stop());
    h.bridge.api.runtime.events.onAgentEvent = callback => {emit = callback; return () => {};};
    h.bridge.api.runtime.channel = {
      session: {resolveStorePath(){return '/unused';},recordInboundSession(){}},
      inbound: {run({adapter}) {
        const turn = adapter.resolveTurn();
        const promise = turn.runDispatch();
        pending.at(-1).skip = turn.runDispatchLifecycle.onDispatchSkipped;
        return promise;
      }},
      reply: {
        createReplyDispatcherWithTyping(){return {dispatcher:{}};},
        dispatchReplyFromConfig({replyOptions,ctx}) {
          return new Promise((resolve,reject) => pending.push({resolve,reject,start:replyOptions.onAgentRunStart,sessionKey:ctx.SessionKey}));
        },
      },
    };
    const transcript = () => sockets.at(-1).send(JSON.stringify({type:'agent.transcript',deviceId:'dev-test',text:'Speak'}));
    const event = (runId,stream,data) => emit({runId,sessionKey:runId === 'new-run' && stream === 'assistant' ? undefined : pending[0].sessionKey,stream,data});
    h.bridge.start();
    await until(() => h.bridge.authenticated);
    transcript();
    await until(() => pending.length === 1);
    pending[0].start('old-run');
    if (replacement === 'stop/start') {h.bridge.stop();h.bridge.start();}
    else sockets[0].close();
    await until(() => sockets.length === 2 && h.bridge.authenticated);
    transcript();
    await until(() => pending.length === 2); // Old promise is still unresolved.
    assert.equal(pending[0].sessionKey,pending[1].sessionKey);
    const active = h.bridge.activeRuns.get('dev-test');
    pending[1].start('new-run');
    event('new-run','assistant',{delta:'NO'}); // Preserve replacement sentinel state too.
    pending[0].start('late-old-run');
    for (const runId of ['old-run','late-old-run']) {
      event(runId,'lifecycle',{phase:'start'});
      event(runId,'assistant',{delta:'stale'});
      event(runId,'error',{});
      event(runId,'lifecycle',{phase:'end'});
    }
    pending[0].skip('old skip');
    if (replacement === 'stop/start') pending[0].reject(new Error('old failure'));
    else pending[0].resolve({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.bridge.activeRuns.get('dev-test'),active);
    assert.equal(h.bridge.sentinelBuffer.get('dev-test'),'NO');
    assert.equal(h.bridge.runIdToTurn.get('new-run'),active);
    event('old-run','assistant',{delta:'after completion'});
    event('new-run','assistant',{delta:'w speaking'});
    event('new-run','lifecycle',{phase:'end'});
    await until(() => responses.some(frame => frame.type === 'agent.response.end'));
    assert.deepEqual(responses,[
      {type:'agent.response.delta',deviceId:'dev-test',runId:active.protocolRunId,text:'NOw speaking'},
      {type:'agent.response.end',deviceId:'dev-test',runId:active.protocolRunId},
    ]);
    pending[1].resolve({});
    await until(() => h.bridge.activeRuns.size === 0);
    assert.equal(h.bridge.runIdToTurn.size,0);
    assert.ok(!h.logs.some(line => line.includes('Invalid inbound frame')));
  });
}

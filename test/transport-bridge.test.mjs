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

test('WS refuses redirect before channel authentication and never reports connected',async t=>{
  let forwarded=0;
  const destination=await listen(t,http.createServer((req,res)=>{forwarded++;res.end();}));
  const source=await listen(t,http.createServer((req,res)=>{res.writeHead(302,{Location:destination.replace('http:','ws:')+'/channel'});res.end();}));
  const h=harness(source);t.after(()=>h.bridge.stop());h.bridge.start();
  await until(()=>h.logs.some(line=>line.includes('connection failed')));
  assert.equal(forwarded,0);assert.equal(h.counts().connected,0);assert.equal(h.state.value,'disconnected');
});

test('real WS waits for ready, ignores early transcripts, sanitizes frames/errors and clears turns on disconnect',async t=>{
  let socket,gotAuth=false,dispatched=0;
  const origin=await wsFixture(t,ws=>{socket=ws;ws.on('message',data=>{const frame=JSON.parse(String(data));if(frame.type==='channel.auth')gotAuth=true;});});
  const h=harness(origin);t.after(()=>h.bridge.stop());
  h.bridge.dispatchTranscript=async()=>{dispatched++;};
  h.bridge.start();await until(()=>gotAuth);
  assert.equal(h.counts().connected,0);
  socket.send(JSON.stringify({type:'channel.transcript',deviceId:'dev-test',text:'before-auth'}));
  await delay(20);assert.equal(dispatched,0);
  socket.send(JSON.stringify({type:'channel.ready',channelId:'int_test'}));await until(()=>h.counts().connected===1);
  socket.send('invalid-frame-secret-sentinel');
  socket.send(JSON.stringify({type:'unknown-secret-sentinel',message:'error-secret-sentinel'}));
  socket.send(JSON.stringify({type:'error',code:'unknown-secret-sentinel',message:'error-secret-sentinel'}));
  socket.send(JSON.stringify({type:'channel.device_state',deviceId:'device-secret-sentinel',state:'state-secret-sentinel'}));
  socket.send(JSON.stringify({type:'channel.transcript',deviceId:'dev-test',text:'after-auth'}));
  await until(()=>dispatched===1);
  h.bridge.activeRuns.set('dev-test',{deviceId:'dev-test',protocolRunId:'run'});
  h.bridge.runIdToTurn.set('run',{deviceId:'dev-test',protocolRunId:'run'});
  socket.close(1000,'close-secret-sentinel');await until(()=>h.state.value==='disconnected');
  assert.equal(h.bridge.activeRuns.size,0);assert.equal(h.bridge.runIdToTurn.size,0);
  assert.ok(!h.logs.join('\n').includes('secret-sentinel'));
});

test('rotation reconnects using replacement and ready gates new connection; revoked stops retries explicitly',async t=>{
  const sockets=[],authorities=[];
  const origin=await wsFixture(t,ws=>{sockets.push(ws);ws.on('message',data=>{const frame=JSON.parse(String(data));if(frame.type==='channel.auth')authorities.push(frame.token);});});
  const h=harness(origin);t.after(()=>h.bridge.stop());h.bridge.start();
  await until(()=>authorities.length===1);sockets[0].send(JSON.stringify({type:'channel.ready',channelId:'int_test'}));await until(()=>h.state.value==='connected');
  h.rotate();await h.bridge.refresh();await until(()=>authorities.length===2);
  assert.notEqual(authorities[0],authorities[1]);assert.equal(h.state.value,'disconnected');
  sockets[1].send(JSON.stringify({type:'channel.ready',channelId:'int_test'}));await until(()=>h.counts().connected===2);
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
const childCode=`
import {requestJson} from './dist/src/transport.js';
import {VauxrBridge} from './dist/src/bridge.js';
let connected=false,processed=0;const logs=[],warnings=[];
const api={logger:{debug:m=>logs.push(m),warn:m=>{logs.push(m);warnings.push(m);}},runtime:{events:{onAgentEvent(){return ()=>{};}}}};
const auth={status(){return {state:connected?'connected':'disconnected'};},subject(){return 'int_test';},async tick(){},async bearer(){return 'tls-test-authority';},connected(){connected=true;},disconnected(){},async rejected(){}};
let http=false;try{http=(await requestJson(process.env.TEST_ORIGIN,'/api/check',{},'tls-test-authority')).ok===true;}catch(error){logs.push(String(error));}
const bridge=new VauxrBridge(api,{url:process.env.TEST_ORIGIN,strictTls:true},auth);
bridge.dispatchTranscript=async(deviceId,text)=>{if(deviceId!=='tls-device'||text!=='post-ready')throw new Error('Unexpected transcript');processed++;};
bridge.start();
const deadline=Date.now()+1500;while(processed!==1&&!logs.some(x=>x.includes('connection failed'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
const authenticated=bridge.authenticated;bridge.stop();console.log(JSON.stringify({http,connected,authenticated,processed,logs,warnings}));
`;

test('actual HTTPS and WSS validate explicit test CA, reject untrusted roots, wrong SAN and expired certificates without downgrade',async t=>{
  const certs=certificates(t);
  for(const [name,trust,expected] of [['trusted',true,true],['trusted',false,false],['wrong-san',true,false],['expired',true,false]]) {
    let httpCalls=0,authFrames=0;
    const server=https.createServer(certs.options(name),(req,res)=>{httpCalls++;res.setHeader('Content-Type','application/json');res.end('{"ok":true}');});
    const origin=await listen(t,server);
    const wss=new WebSocketServer({server});
    wss.on('connection',ws=>ws.on('message',data=>{if(JSON.parse(String(data)).type==='channel.auth'){authFrames++;ws.send('{"type":"channel.ready","channelId":"int_test"}');ws.send('{"type":"channel.transcript","deviceId":"tls-device","text":"post-ready"}');}}));
    t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();});
    const env={...process.env,TEST_ORIGIN:origin};
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;delete env.NODE_EXTRA_CA_CERTS;
    if(trust)env.NODE_EXTRA_CA_CERTS=join(certs.dir,'ca.pem');
    const result=await run(process.execPath,['--input-type=module','-e',childCode],{cwd:process.cwd(),env,timeout:8000});
    const actual=JSON.parse(result.stdout);
    assert.equal(actual.http,expected,`${name} HTTPS with trust=${trust}`);
    assert.equal(actual.connected,expected,`${name} WSS with trust=${trust}`);
    assert.equal(actual.authenticated,expected,`${name} authenticated WSS with trust=${trust}`);
    assert.equal(actual.processed,expected?1:0,`${name} post-ready transcript with trust=${trust}`);
    assert.deepEqual(actual.warnings.filter(message=>message!=='[vauxr-bridge] WebSocket connection failed'),[]);
    if(expected)assert.deepEqual(actual.warnings,[]);
    assert.equal(httpCalls,expected?1:0);assert.equal(authFrames,expected?1:0);
    assert.ok(!JSON.stringify(actual).includes('tls-test-authority'));
  }
});

test('origin binding rejects mixed schemes, hosts, URL credentials and strict LAN downgrade',()=>{
  for(const config of [{url:'wss://localhost:8443',httpUrl:'http://localhost:8080'},{url:'ws://localhost:8765',httpUrl:'http://other.invalid:8080'},{url:'ws://user:password@localhost:8765'},{url:'ws://localhost:8765',strictTls:true}])assert.throws(()=>endpoints(config));
  assert.deepEqual(endpoints({url:'http://localhost:8765'}),{origin:'http://localhost:8080',wsUrl:'ws://localhost:8765/channel'});
});

test('a retired voice turn cannot send errors through the replacement authenticated socket',async t=>{
  let connections=0,rejectDispatch,onSkipped;
  const responses=[];
  const origin=await wsFixture(t,ws=>{
    connections++;
    ws.on('message',data=>{
      const frame=JSON.parse(String(data));
      if(frame.type==='channel.auth')ws.send(JSON.stringify({type:'channel.ready',channelId:'int_test'}));
      else responses.push(frame);
    });
    if(connections===1)setTimeout(()=>ws.send(JSON.stringify({type:'channel.transcript',deviceId:'dev-test',text:'Start a voice turn'})),15);
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

test('ready for another channel cannot mark the integration connected',async t=>{
  const origin=await wsFixture(t,ws=>ws.on('message',()=>ws.send(JSON.stringify({type:'channel.ready',channelId:'int_someone_else'}))));
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
        if (frame.type === 'channel.auth') ws.send(JSON.stringify({type:'channel.ready',channelId:'int_test'}));
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
    const transcript = () => sockets.at(-1).send(JSON.stringify({type:'channel.transcript',deviceId:'dev-test',text:'Speak'}));
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
    await until(() => responses.some(frame => frame.type === 'channel.response.end'));
    assert.deepEqual(responses,[
      {type:'channel.response.delta',deviceId:'dev-test',runId:active.protocolRunId,text:'NOw speaking'},
      {type:'channel.response.end',deviceId:'dev-test',runId:active.protocolRunId},
    ]);
    pending[1].resolve({});
    await until(() => h.bridge.activeRuns.size === 0);
    assert.equal(h.bridge.runIdToTurn.size,0);
    assert.ok(!h.logs.some(line => line.includes('Invalid inbound frame')));
  });
}

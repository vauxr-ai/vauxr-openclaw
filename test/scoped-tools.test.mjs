import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { VauxrAPIClient } from '../dist/src/api-client.js';
import { registerTools } from '../dist/src/tools.js';

const row = () => ({request_id:'a'.repeat(32), device_id:'dev_'+'b'.repeat(64), kind:'physical', display_name:'Kitchen', status:'ready', expires_at:Math.floor(Date.now()/1000)+100});
let origin;
async function fake(t, handler) {
  const calls=[];
  const server=http.createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk;
    const body=data ? JSON.parse(data) : undefined;
    const url=origin+req.url;
    const options={method:req.method,headers:req.headers};
    calls.push({url,body,options});
    try {
      const result=await handler(url,body,options);
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
    } catch(error) {res.writeHead(500);res.end('{}');throw error;}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  origin=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return calls;
}
const client=()=>new VauxrAPIClient(origin,async()=> 'test-only-authority');

test('fresh protected provider is read per request; only device display projection escapes', async t=>{
  const calls=await fake(t,()=>[{id:'dev-1', name:'Kitchen vx_dev_redaction_sentinel',state:'idle',lastSeen:'today',credential:'never-project',config:{barge_in:false,token:'never-project'}}]);
  let reads=0;
  const api=new VauxrAPIClient(origin,async()=>{reads++;return 'test-only-authority';});
  const devices=await api.listDevices();
  await api.listDevices();
  assert.equal(reads,2);
  assert.equal(calls[0].options.method,'GET');
  assert.deepEqual(devices,[{id:'dev-1',name:'Kitchen [redacted]',state:'idle',lastSeen:'today',config:{barge_in:false}}]);
});

test('both physical control steps validate identity, state and window; responses never disclose device credential or code',async t=>{
  const pending=row();
  const calls=await fake(t,(url,body)=>{
    if(url.endsWith('/list')) return {version:1,requests:[{...pending,code:'never-project',device_token:'never-project'}]};
    assert.deepEqual(Object.keys(body).sort(),['code','request_id']);
    pending.status=url.endsWith('/initiate')?'initiated':'approved';
    return {status:pending.status,device_id:pending.device_id,device_token:'never-project',code:'never-project'};
  });
  const confirmation={request_id:pending.request_id,device_id:pending.device_id,code:'01234567',heard_from_device:true,physical_window_open:true};
  assert.deepEqual(await client().confirmPairing('initiate',confirmation),{status:'initiated',device_id:pending.device_id});
  assert.deepEqual(await client().confirmPairing('approve',confirmation),{status:'approved',device_id:pending.device_id});
  assert.equal(calls.length,4);
});

test('missing human confirmation, expiry, terminal state and mismatched device do not mutate server',async t=>{
  const pending=row();
  const calls=await fake(t,()=>({version:1,requests:[pending]}));
  const confirmation={request_id:pending.request_id,device_id:pending.device_id,code:'01234567',heard_from_device:true,physical_window_open:true};
  for(const change of [{heard_from_device:false},{physical_window_open:false},{code:'1234567'},{code:'12345678\n'}]) await assert.rejects(client().confirmPairing('initiate',{...confirmation,...change}));
  assert.equal(calls.length,0);
  await assert.rejects(client().confirmPairing('initiate',{...confirmation,device_id:'dev_'+'c'.repeat(64)}));
  for(const status of ['denied','expired','failed','stale','consumed']) {
    pending.status=status;
    await assert.rejects(client().confirmPairing('initiate',confirmation));
  }
  pending.status='ready';pending.expires_at=Math.floor(Date.now()/1000)-1;
  await assert.rejects(client().confirmPairing('initiate',confirmation));
  assert.ok(calls.every(call=>call.url.endsWith('/list')));
});

test('control allowlist denies administration and reserved playback, validates params and strips extras',async t=>{
  const calls=await fake(t,()=>({ok:true}));
  for(const command of ['rotate','revoke','set_config','playback','play','__proto__']) await assert.rejects(client().command('dev-1',command));
  for(const volume of [undefined,-1,101,NaN,Infinity,'50']) await assert.rejects(client().command('dev-1','set_volume',{volume}));
  assert.equal(calls.length,0);
  await client().command('dev-1','set_volume',{volume:20,credential:'never-send'});
  await client().command('dev-1','mute',{credential:'never-send'});
  await client().command('dev-1','set_barge_in',{enabled:false});
  await client().command('dev-1','ota',{url:'http://localhost:8080/firmware/satellite1.bin'});
  assert.deepEqual(calls[0].body,{command:'set_volume',params:{volume:20}});
  assert.deepEqual(calls[1].body,{command:'mute'});
});

test('integration mints a same-origin single-use firmware URL before OTA dispatch',async t=>{
  const token='a'.repeat(43);
  const calls=await fake(t,(url,body)=>{
    if(url.endsWith('/api/firmware-delivery/voicepe.bin')) {
      assert.deepEqual(body,{});
      return {url:`${origin}/firmware-delivery/${token}/voicepe.bin`,expires_in:120};
    }
    return {ok:true};
  });
  const api=client();
  const delivery=await api.mintFirmwareDelivery('voicepe.bin');
  await api.command('dev-1','ota',{url:delivery});
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.headers.authorization,'Bearer test-only-authority');
  assert.deepEqual(calls[1].body,{command:'ota',params:{url:delivery}});
});

test('firmware delivery rejects unsafe names and malformed or cross-origin capabilities',async t=>{
  let response;
  await fake(t,()=>response);
  const api=client();
  for(const name of ['voicepe','../voicepe.bin','voicepe.bin?secret','voicepe.bin/other']) {
    await assert.rejects(api.mintFirmwareDelivery(name),/Invalid firmware filename/);
  }
  const token='a'.repeat(43);
  for(const value of [
    {url:`http://example.invalid/firmware-delivery/${token}/voicepe.bin`,expires_in:120},
    {url:`${origin}/firmware-delivery/${token}/other.bin`,expires_in:120},
    {url:`${origin}/firmware-delivery/short/voicepe.bin`,expires_in:120},
    {url:`http://user:secret@${new URL(origin).host}/firmware-delivery/${token}/voicepe.bin`,expires_in:120},
    {url:`${origin}/firmware-delivery/${token}/voicepe.bin?secret=1`,expires_in:120},
    {url:`${origin}/firmware-delivery/${token}/voicepe.bin`,expires_in:0},
    {url:`${origin}/firmware-delivery/${token}/voicepe.bin`,expires_in:121},
    {url:`${origin}/firmware-delivery/${token}/voicepe.bin`,expires_in:'120'},
  ]) {
    response=value;
    await assert.rejects(api.mintFirmwareDelivery('voicepe.bin'),/Invalid firmware delivery response/);
  }
});

test('vauxr_control mints and dispatches filename OTA without exposing its capability',async()=>{
  const tools=[]; const calls=[];
  registerTools({registerTool(tool){tools.push(tool);}}, {
    async mintFirmwareDelivery(name){calls.push(['mint',name]);return 'http://server/firmware-delivery/'+'a'.repeat(43)+'/'+name;},
    async command(device,command,params){calls.push(['command',device,command,params]);},
    defaultOtaUrl(){return undefined;},
  });
  const control=tools.find(tool=>tool.name==='vauxr_control');
  const result=await control.execute('1',{device_id:'dev-1',command:'ota',firmware_filename:'voicepe.bin'});
  assert.deepEqual(calls.map(call=>call[0]),['mint','command']);
  assert.equal(JSON.stringify(result).includes('firmware-delivery'),false);
  await assert.rejects(control.execute('2',{device_id:'dev-1',command:'ota'}),/requires firmware_filename/);
  await assert.rejects(control.execute('3',{device_id:'dev-1',command:'ota',url:'http://server/fw.bin',firmware_filename:'voicepe.bin'}),/either/);
});

test('strict HTTPS rejects HTTP API and firmware downgrade, embedded credentials and query secrets',async t=>{
  const calls=await fake(t,()=>({ok:true}));
  assert.throws(()=>new VauxrAPIClient('http://localhost:8080',async()=>'',undefined,true));
  const secure=new VauxrAPIClient('https://localhost:8443',async()=> 'test-only-authority');
  for(const url of ['http://localhost/fw.bin','https://user:pass@localhost/fw.bin','https://localhost/fw.bin?token=secret','https://localhost/fw.bin#secret']) await assert.rejects(secure.command('dev-1','ota',{url}));
  assert.equal(calls.length,0);
  const ota=new VauxrAPIClient('https://localhost:8443',async()=>'', 'https://firmware.local');
  assert.equal(ota.defaultOtaUrl(),'https://firmware.local/firmware/satellite1.bin');
});

test('registered tools expose scoped operations and truthful pairing outcome without echoing code',async()=>{
  const tools=[];
  registerTools({registerTool(tool){tools.push(tool);}}, {async confirmPairing(){return {status:'approved',device_id:'dev-1'};}});
  assert.deepEqual(tools.map(tool=>tool.name),['vauxr_devices','vauxr_announce','vauxr_control','vauxr_pairing']);
  const pairing=tools.at(-1);
  assert.match(pairing.description,/directly supplied by the user/);
  const result=await pairing.execute('1',{action:'approve',code:'01234567'});
  assert.match(result.content[0].text,/must finish enrollment/);
  assert.ok(!JSON.stringify(result).includes('01234567'));
});

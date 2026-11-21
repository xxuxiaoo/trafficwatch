import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import net from 'node:net';
import {startOverviewServer} from '../src/overview-server.mjs';
import {HistoryReader} from '../src/history-reader.mjs';
import {fixture,connection,record,rule} from './history-synthetic-fixtures.mjs';
import {airportGroupKey} from '../src/proxy-airports.mjs';

async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('diagnostics serves its complete browser module dependency graph with JavaScript content types',async t=>{
  const f=fixture(t),port=await freePort(),app=startOverviewServer({historyRoot:f.root,listenPort:port,sourcePorts:[await freePort(),await freePort()],suiteSettings:{},guardFactory:()=>({start(){},close(){}})});
  t.after(()=>app.close());
  await new Promise(resolve=>app.server.listening?resolve():app.server.once('listening',resolve));
  const base='http://127.0.0.1:'+port,visited=new Set(),pending=['/diagnostics.js'];
  while(pending.length){
    const route=pending.pop();if(visited.has(route))continue;visited.add(route);
    const response=await fetch(base+route);
    assert.equal(response.status,200,route+' must load before the vault redirect can run');
    assert.match(response.headers.get('content-type'),/javascript/);
    const source=await response.text();
    for(const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)){
      if(match[1].startsWith('.'))pending.push(new URL(match[1],base+route).pathname);
    }
  }
  assert(visited.has('/tcp-evidence.mjs'));assert(!visited.has('/vault-browser.mjs'));
});

test('an interactive detail finishes while a whole-range overview is still running',async t=>{
  const f=fixture(t),readers=new Map();let overviewStarted,releaseOverview;
  const started=new Promise(resolve=>overviewStarted=resolve);
  class ReaderWorker extends EventEmitter{
    constructor(role){super();this.role=role;}
    postMessage(message){
      const finish=data=>queueMicrotask(()=>this.emit('message',{id:message.id,data}));
      if(message.type==='apps')return finish({apps:{codex:['codex.exe'],claude:[],dsh:[]}});
      if(this.role==='history'){
        overviewStarted();releaseOverview=()=>finish({machine:{available:true},clash:{available:true}});return;
      }
      finish({detail:{available:true,range:{from:1000,to:2000},summary:{up:123,down:456},connections:[],pagination:{page:0,total:0,pages:0,pageSize:100}}});
    }
    terminate(){return Promise.resolve(0);}
  }
  const port=await freePort(),app=startOverviewServer({historyRoot:f.root,listenPort:port,sourcePorts:[await freePort(),await freePort()],guardFactory:callback=>({start(){callback({state:'unlocked'});},close(){}}),readerFactory:(data,options,role)=>{
    const reader=new HistoryReader(data,{...options,createWorker:()=>new ReaderWorker(role)});readers.set(role,reader);return reader;
  }});
  const abort=new AbortController();t.after(()=>{abort.abort();releaseOverview?.();app.close();});
  await new Promise(resolve=>app.server.listening?resolve():app.server.once('listening',resolve));
  const headers={'x-codex-flow':'1'},base='http://127.0.0.1:'+port;
  const overview=fetch(base+'/api/overview?range=7d',{headers,signal:abort.signal}).then(response=>response.json());overview.catch(()=>{});
  await started;
  const response=await fetch(base+'/api/detail?range=today&lane=clash&route=proxy',{headers,signal:AbortSignal.timeout(2000)});
  assert.equal(response.status,200);assert.equal((await response.json()).summary.up,123);
  assert.equal(readers.get('history').stats().active,true,'the overview has not completed yet');
  assert.equal(readers.get('detail').stats().completed,1);
  releaseOverview();await overview;
});

test('airport queries use the same grouping key for overview, client totals, and node details',async t=>{
  const f=fixture(t),store=f.open('clash'),airport=airportGroupKey('Synthetic subscription');
  record(store,Date.now()-120000,[
    connection('shared-verge',12,34,{rule:rule(['Shared'],{client:'verge',airport:{id:'auto-'+'a'.repeat(24),name:'Synthetic subscription (verge)'}})}),
    connection('shared-flclash',45,67,{rule:rule(['Shared'],{client:'flclash',airport:{id:'auto-'+'b'.repeat(24),name:'Synthetic subscription (flclash)'}})}),
  ]);
  const port=await freePort(),app=startOverviewServer({historyRoot:f.root,listenPort:port,sourcePorts:[await freePort(),await freePort()],suiteSettings:{},guardFactory:callback=>({start(){callback({state:'unlocked'});},close(){}})});
  t.after(()=>app.close());await new Promise(resolve=>app.server.listening?resolve():app.server.once('listening',resolve));
  const base='http://127.0.0.1:'+port,call=route=>fetch(base+route,{headers:{'x-codex-flow':'1'}});
  const overview=await (await call('/api/overview?range=24h')).json();
  assert.deepEqual(overview.clash.airportUsage.map(row=>[row.airport,row.up,row.down]),[[airport,57,101]]);
  const response=await call('/api/ladder?range=24h&client=flclash&airport='+airport);
  assert.equal(response.status,200);assert.deepEqual((await response.json()).groups.proxy,{up:45,down:67});
  const detail=await (await call('/api/detail?range=24h&lane=clash&route=proxy&client=flclash&node=Shared&airport='+airport)).json();
  assert.deepEqual(detail.connections.map(row=>[row.host,row.up,row.down]),[['shared-flclash.example.test',45,67]]);
  for(const route of ['/api/ladder/nodes','/api/airport-groups','/history','/index.html'])assert.equal((await call(route)).status,404,route);
  assert.equal((await call('/api/ladder?client=verge&airport=bad%20value',{headers:{'x-codex-flow':'1'}})).status,400);
});

test('the portable Mihomo reader displays its database on the proxy lane', async t => {
  const f = fixture(t), store = f.open('');
  record(store, Date.now() - 120000, [connection('portable-mihomo', 123, 456, { rule: rule() })]);
  const reader = new HistoryReader({ dataRoot: f.root, singleCollector: 'mihomo' });
  try {
    const { machine, clash } = await reader.query({ type: 'overview', range: '24h', options: { quick: true } });
    assert.equal(machine.available, false);
    assert.equal(clash.available, true);
    assert.deepEqual(clash.groups.proxy, { up: 123, down: 456 });
  } finally { await reader.close(); }
});

test('collection controls verify origin and report action contention or failure',async t=>{
  const f=fixture(t),port=await freePort(),invoked=[];let enrolled,endPause;
  const started=new Promise(resolve=>enrolled=resolve);
  const app=startOverviewServer({historyRoot:f.root,listenPort:port,sourcePorts:[await freePort(),await freePort()],guardFactory:()=>({start(){},close(){}}),controlRunner:action=>{
    invoked.push(action);
    if(action==='PauseCapture')return new Promise(resolve=>{endPause=()=>resolve({ok:true,action});enrolled();});
    throw new Error('control_action_cancelled');
  }});
  t.after(()=>{endPause?.();app.close();});
  await new Promise(resolve=>app.server.listening?resolve():app.server.once('listening',resolve));
  const base='http://127.0.0.1:'+port,post=(action,origin=base)=>fetch(base+'/api/control/action',{method:'POST',headers:{'x-codex-flow':'1',Origin:origin,'content-type':'application/json'},body:JSON.stringify({action})});
  assert.equal((await post('Start','http://example.test')).status,403);
  assert.equal((await post('Unknown')).status,400);
  const pause=post('PauseCapture');await started;
  assert.equal((await post('Start')).status,409);
  endPause();assert.equal((await pause).status,200);
  const cancelled=await post('Start');assert.equal(cancelled.status,503);assert.deepEqual(await cancelled.json(),{error:'control_action_cancelled'});
  assert.deepEqual(invoked,['PauseCapture','Start']);
});

test('stopping the suite replies before closing its overview; a cancelled stop leaves it open', async t => {
  const f = fixture(t), port = await freePort(), actions = [];
  let cancel = true;
  const app = startOverviewServer({
    historyRoot: f.root, listenPort: port, sourcePorts: [await freePort(), await freePort()], suiteSettings: {},
    guardFactory: () => ({ start() {}, close() {} }),
    controlRunner: action => {
      actions.push(action);
      if (cancel) throw new Error('control_action_cancelled');
      return { ok: true, action };
    },
  });
  t.after(() => { if (app.server.listening) app.close(); });
  if (!app.server.listening) await once(app.server, 'listening');
  const base = `http://127.0.0.1:${port}`;
  const stop = action => fetch(base + '/api/control/action', {
    method: 'POST', headers: { Origin: base, 'x-codex-flow': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }), signal: AbortSignal.timeout(2000),
  });
  assert.equal((await stop('StopFromOverview')).status, 400);
  assert.equal((await stop('Stop')).status, 503);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  cancel = false;
  const closed = once(app.server, 'close', { signal: AbortSignal.timeout(3000) });
  const response = await stop('Stop');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, action: 'Stop' });
  await closed;
  assert.equal(app.server.listening, false);
  assert.deepEqual(actions, ['Stop', 'Stop']);
});

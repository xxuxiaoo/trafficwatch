import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {startOverviewServer} from '../src/overview-server.mjs';
import {HistoryReader} from '../src/history-reader.mjs';
import {fixture} from './history-synthetic-fixtures.mjs';

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
  assert(visited.has('/tcp-evidence.mjs'));assert(visited.has('/vault-browser.mjs'));
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

test('airport and client selection uses a separate bounded ladder query and loads node inventory only on demand',async t=>{
  const f=fixture(t);let ladderRequest,ladderNodesRequest;const readers=new Map();
  class ReaderWorker extends EventEmitter{
    constructor(role){super();this.role=role;}
    postMessage(message){
      const data=message.type==='apps'?{apps:{codex:['codex.exe'],claude:[],dsh:[]}}:{detail:{available:true,lane:'clash',groups:{proxy:{up:12,down:34},direct:{up:0,down:0},unknown:{up:0,down:0}},airportUsage:[{client:'flclash',airport:'tag',up:12,down:34,connections:1}],clientNodes:[{client:'flclash',name:'TAG-HK-1'}],routeTimeline:[],routePrograms:{proxy:[]},routeDomains:{proxy:[]},routeNodes:{proxy:[]},range:{from:1000,to:2000,intervalMs:60000}}};
      if(message.type==='ladder')ladderRequest=message;
      if(message.type==='ladder-nodes')ladderNodesRequest=message;
      queueMicrotask(()=>this.emit('message',{id:message.id,data}));
    }
    terminate(){return Promise.resolve(0);}
  }
  const port=await freePort(),app=startOverviewServer({historyRoot:f.root,listenPort:port,sourcePorts:[await freePort(),await freePort()],guardFactory:callback=>({start(){callback({state:'unlocked'});},close(){}}),readerFactory:(data,options,role)=>{
    const reader=new HistoryReader(data,{...options,createWorker:()=>new ReaderWorker(role)});readers.set(role,reader);return reader;
  }});
  t.after(()=>app.close());await new Promise(resolve=>app.server.listening?resolve():app.server.once('listening',resolve));
  const base='http://127.0.0.1:'+port,headers={'x-codex-flow':'1'},response=await fetch(base+'/api/ladder?range=7d&client=flclash&airport=tag',{headers});
  assert.equal(response.status,200);assert.equal((await response.json()).airportUsage[0].client,'flclash');
  assert.equal(ladderRequest.type,'ladder');assert.equal(ladderRequest.options.client,'flclash');assert.equal(ladderRequest.options.airport,'tag');assert.equal(ladderRequest.options.lane,'clash');
  const inventory=await fetch(base+'/api/ladder/nodes?range=7d',{headers});assert.equal(inventory.status,200);assert.equal((await inventory.json()).clientNodes[0].name,'TAG-HK-1');
  assert.equal(ladderNodesRequest.type,'ladder-nodes');assert.equal(ladderNodesRequest.options.lane,'clash');
  assert.equal((await fetch(base+'/api/ladder?client=verge&airport=bad%20value',{headers})).status,400);
});

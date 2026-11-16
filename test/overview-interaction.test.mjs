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

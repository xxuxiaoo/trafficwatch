import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { readLane, readDetail } from '../src/overview-data.mjs';
import { HistoryReader } from '../src/history-reader.mjs';
import { fixture, BASE, MINUTE, record, connection } from './history-synthetic-fixtures.mjs';
const HOUR = 60 * MINUTE;
function normalize(rows) {return [...rows].sort((a,b)=>JSON.stringify([a.process,a.scope,a.family]).localeCompare(JSON.stringify([b.process,b.scope,b.family])));}

test('durable rollups exactly preserve interval edges, distinct connections, scopes, aliases and new traffic', t=>{
  const f = fixture(t), store=f.open('windows'),cacheRoot=path.join(f.root,'viewer-cache');
  const unknown={process:'',pid:null,scope:'unknown',evidence:'none',family:'unknown'};
  for(const [offset,rows] of [
    [5*MINUTE,[connection('same',1,10),connection('identify-later',2,20,unknown)]],
    [HOUR+MINUTE,[connection('same',3,30),connection('other',4,40),connection('legacy-codex',10,100,{process:'renamed-helper.exe',scope:'codex'})]],
    [2*HOUR+MINUTE,[connection('same',5,50)]],
    [3*HOUR+MINUTE,[connection('same',6,60),connection('tail-only',7,70)]],
  ])record(store,BASE+offset,rows);
  const now=BASE+3*HOUR+30*MINUTE;
  const options={from:BASE+3*MINUTE,to:now};
  const check=(name='all',optionsOverride={})=>{
    const direct=readLane(f.root,'windows',name,now,{...options,...optionsOverride});
    for(let i=0;i<2;i++){
      const cached=readLane(f.root,'windows',name,now,{...options,...optionsOverride,cacheRoot});
      assert.equal(cached.available,true);
      assert.deepEqual(normalize(cached.allPrograms),normalize(direct.allPrograms));
      assert.deepEqual(cached.familyTotals,direct.familyTotals);assert.deepEqual(cached.unassigned,direct.unassigned);
    }
  };
  check();
  record(store,BASE+3*HOUR+2*MINUTE,[connection('identify-later',8,80,{process:'dsh.exe',family:'dsh',familyRoot:'dsh.exe'}),connection('same',9,90)]);
  check();
  check('all',{apps:{codex:['codex.exe'],claude:['browser.exe'],dsh:['dsh.exe']}});
  check('all',{from:BASE+HOUR+2*MINUTE,to:BASE+3*HOUR+MINUTE});
  const detail=readDetail(f.root,'windows','all',now,options);
  assert.ok(detail.observation.timeline.length>0,'detail gets its own sampling evidence at its actual resolution');
  const codex=readDetail(f.root,'windows','all',now,{...options,cacheRoot,family:'codex'});
  assert.equal(codex.summary.up,10);assert.equal(codex.connections[0].process,'renamed-helper.exe');
});

test('quick overview includes real totals and marks pending attribution instead of fabricated zeros', t=>{
  const f=fixture(t),store=f.open('windows');record(store,BASE+1000,[connection('application',12,34)]);
  const quick=readLane(f.root,'windows','all',BASE+MINUTE,{quick:true});
  assert.equal(quick.detailReady,false);assert.equal(quick.totals.up,12);assert.equal(quick.totals.down,34);assert.equal(quick.timeline.length,1);
});
test('a broken disposable cache falls back to source records without hiding history',t=>{
  const f=fixture(t),store=f.open('windows');
  record(store,BASE+MINUTE,[connection('retained',11,22)]);
  const broken=path.join(f.root,'not-a-directory');fs.writeFileSync(broken,'synthetic cache failure');
  const result=readLane(f.root,'windows','all',BASE+3*HOUR,{cacheRoot:broken});
  assert.equal(result.available,true);assert.equal(result.allPrograms[0].up,11);assert.equal(result.cacheWarning,'summary_cache_unavailable');
});

class FakeWorker extends EventEmitter {
  sent=[];terminated=false;
  postMessage(value){this.sent.push(value);}
  terminate(){this.terminated=true;return Promise.resolve(0);}
  complete(data={ok:true}){this.emit('message',{id:this.sent.at(-1).id,data});}
}
test('reader deduplicates equal queries and removes abandoned queued work', async()=>{
  const workers=[];const reader=new HistoryReader({}, {createWorker:()=>{const w=new FakeWorker();workers.push(w);return w;}});
  try{
    const first=reader.query({range:'7d'}),shared=reader.query({range:'7d'});
    const cancel=new AbortController();const abandoned=reader.query({range:'30d'},{signal:cancel.signal});
    const rejected=assert.rejects(abandoned,/request_cancelled/);cancel.abort();await rejected;
    assert.equal(reader.stats().queued,0);assert.equal(workers[0].sent.length,1);
    workers[0].complete({amount:100});assert.deepEqual(await first,{amount:100});assert.deepEqual(await shared,{amount:100});
  }finally{reader.close();}
});
test('a query timeout terminates its worker and the next request recovers without a service restart', async()=>{
  const workers=[];const reader=new HistoryReader({}, {timeoutMs:30,createWorker:()=>{const w=new FakeWorker();workers.push(w);return w;}});
  try{
    await assert.rejects(reader.query({range:'all'}),/history_timeout/);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(workers[0].terminated,true);
    const next=reader.query({range:'today'});workers[1].complete({recovered:true});assert.deepEqual(await next,{recovered:true});
    assert.equal(reader.stats().restarts,1);
  }finally{reader.close();}
});
test('canceling an active request stops SQL and a crashed reader recovers', async()=>{
  const workers=[];const reader=new HistoryReader({}, {createWorker:()=>{const w=new FakeWorker();workers.push(w);return w;}});
  try{
    const cancel=new AbortController();const request=reader.query({range:'7d'},{signal:cancel.signal});
    const rejected=assert.rejects(request,/request_cancelled/);cancel.abort();await rejected;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(workers[0].terminated,true);
    const failed=reader.query({range:'30d'});const rejectedCrash=assert.rejects(failed,/reader_unavailable/);workers[1].emit('error',new Error('test failure'));await rejectedCrash;
    await new Promise(resolve=>setImmediate(resolve));
    const recovery=reader.query({range:'today'});workers[2].complete();await recovery;
  }finally{reader.close();}
});

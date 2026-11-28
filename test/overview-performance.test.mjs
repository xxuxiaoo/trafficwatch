import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { readLane, readDetail,readHarness,readLadder } from '../src/overview-data.mjs';
import { airportGroupKey } from '../src/proxy-airports.mjs';
import { Store, RETIRED_AIRPORT_SETTING } from '../src/store.mjs';
import { HistoryReader } from '../src/history-reader.mjs';
import { initializeArchives,attachArchiveViews,setArchiveWindows } from '../src/history-archive.mjs';
import { fixture, BASE, MINUTE, record, connection,rule } from './history-synthetic-fixtures.mjs';
const HOUR = 60 * MINUTE;
function normalize(rows) {return [...rows].sort((a,b)=>JSON.stringify([a.process,a.scope,a.family]).localeCompare(JSON.stringify([b.process,b.scope,b.family])));}

test('lightweight harness queries exactly match full details for aliases, scoped unknown history, repeated identities and proxy routes',t=>{
  const f=fixture(t);
  for(const lane of ['windows','clash']){
    const store=f.open(lane);initializeArchives(store);
    for(const offset of [MINUTE,HOUR+MINUTE,2*HOUR+MINUTE])record(store,BASE+offset,[
      connection('legacy',1,2,{process:'renamed.exe',scope:'codex',rule:rule()}),
      connection('script',3,4,{process:'node.exe',family:'dsh',familyRoot:'script:dsh',rule:rule()}),
      connection('alias',5,6,{process:'my-claude.exe',rule:rule(['DIRECT'])}),
      connection('unknown',7,8,{process:'codex.exe',scope:'unknown',rule:rule()}),
      connection('ag-bundle',9,10,{process:'language_server.exe',family:'antigravity',familyRoot:'bundle:antigravity',rule:rule()}),
      connection('ag-override',11,12,{process:'Antigravity.exe',family:'antigravity',familyRoot:'antigravity.exe',rule:rule()}),
    ]);
    const now=BASE+3*HOUR,options={from:BASE+2*MINUTE,to:now,apps:{codex:['codex.exe'],claude:['my-claude.exe'],dsh:['dsh.exe','antigravity.exe'],antigravity:['antigravity']}};
    for(const family of ['codex','claude','dsh','antigravity']){
      const request={...options,family,...(lane==='clash'?{route:'proxy'}:{})};
      const full=readDetail(f.root,lane,'all',now,request),light=readHarness(f.root,lane,'all',now,request);
      assert.deepEqual({...light.summary},{...full.summary});assert.deepEqual(light.series.map(({at,up,down})=>({at,up,down})),full.series.map(({at,up,down})=>({at,up,down})));
      assert.deepEqual(normalize(light.processes),normalize(full.processes));assert.deepEqual(light.observation,full.observation);
      if(lane==='clash')assert.deepEqual(light.routeTotals,full.routeTotals);
      assert.equal(Object.hasOwn(light,'connections'),false);assert.equal(Object.hasOwn(light,'destinations'),false);
    }
    // Also exercise multi-day (>48h) candidate-index lookup path on Windows.
    const multiDayNow = BASE + 4 * 24 * HOUR;
    for(const family of ['codex','claude','dsh','antigravity']){
      const request={from:BASE,to:multiDayNow,apps:options.apps,family,...(lane==='clash'?{route:'proxy'}:{})};
      const full=readDetail(f.root,lane,'all',multiDayNow,request),light=readHarness(f.root,lane,'all',multiDayNow,request);
      assert.deepEqual({...light.summary},{...full.summary});
      assert.deepEqual(light.series.map(({at,up,down})=>({at,up,down})),full.series.map(({at,up,down})=>({at,up,down})));
      assert.deepEqual(normalize(light.processes),normalize(full.processes));
    }
  }
});

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

test('automatic airport totals reconcile exactly with clients, shared nodes, connections and direct traffic',t=>{
  const f=fixture(t),store=f.open('clash');initializeArchives(store);
  const tag=airportGroupKey('TAG'),verge={id:'auto-'+'a'.repeat(24),name:'TAG (verge)'},fl={id:'auto-'+'b'.repeat(24),name:'ＴＡＧ (flclssh)'};
  record(store,BASE+MINUTE,[
    connection('verge-tag',10,20,{rule:rule(['Shared HK'],{client:'verge',airport:verge})}),
    connection('fl-tag',30,40,{rule:rule(['Shared HK'],{client:'flclssh',airport:fl})}),
    connection('fl-tag-jp',8,9,{rule:rule(['JP'],{client:'flclash',airport:fl})}),
    connection('verge-other',50,60,{rule:rule(['Other HK'],{client:'verge',airport:{...verge,name:'Different airport'}})}),
    connection('legacy-node',70,80,{rule:rule(['Shared HK'],{airport:{id:'manual',name:'TAG'}})}),
    connection('direct',100,200,{rule:rule(['DIRECT'],{client:'verge',airport:verge})}),
  ]);
  const now=BASE+3*HOUR,all=readLane(f.root,'clash','all',now);
  assert.equal(all.airportUsage.length,3);
  const grouped=all.airportUsage.find(row=>row.airport===tag);
  assert.deepEqual([grouped.airportName,grouped.up,grouped.down,grouped.connections],['TAG',48,69,3]);
  assert.deepEqual(grouped.clients.map(row=>[row.client,row.up,row.down]),[['flclash',38,49],['verge',10,20]]);
  assert.deepEqual(all.groups.proxy,{up:168,down:209});
  assert.deepEqual(all.groups.direct,{up:100,down:200});
  assert.equal(all.airportUsage.reduce((n,row)=>n+row.up,0),all.groups.proxy.up);
  assert.equal(all.airportUsage.reduce((n,row)=>n+row.down,0),all.groups.proxy.down);
  assert.equal(all.airportUsage.find(row=>row.airport==='__unassigned__').up,70);
  const ladder=readLadder(f.root,'all',now,{client:'flclash',airport:tag});
  assert.equal(ladder.detailReady,true);
  assert.deepEqual(ladder.groups.proxy,{up:38,down:49});
  assert.deepEqual(ladder.nodes.map(row=>row.name),['Shared HK','JP']);
  const detail=readDetail(f.root,'clash','all',now,{client:'flclash',airport:tag,node:'Shared HK',route:'proxy'});
  const row=detail.connections[0];
  assert.equal(detail.summary.up,30);assert.equal(detail.summary.down,40);assert.equal(detail.connections.length,1);
  assert.deepEqual([row.client,row.airport,row.destinationIP,row.destinationPort],['flclash',tag,'192.0.2.10',443]);
});
test('obsolete group settings disappear during legacy migration and reopening without changing history',async t=>{
  const f=fixture(t),store=f.open('clash');
  store.db.prepare('INSERT INTO settings VALUES (?,?)').run(RETIRED_AIRPORT_SETTING,'[{"id":"manual"}]');
  store.set('retentionDays',0);
  record(store,BASE+MINUTE,[connection('older',30,40,{rule:rule(['Shared node'],{client:'verge'})})]);
  f.close(store);
  const target=f.open('clash');
  try {
    assert.equal(target.get(RETIRED_AIRPORT_SETTING),undefined);
    target.set(RETIRED_AIRPORT_SETTING,[{id:'old-queue'}]);
    assert.equal(target.get(RETIRED_AIRPORT_SETTING),undefined);
    assert.equal(target.get('retentionDays'),0);
    assert.equal(target.totals(0,BASE+3*HOUR).all_up,30);
  } finally { f.close(target); }
  const reopened=f.open('clash');
  assert.equal(reopened.get(RETIRED_AIRPORT_SETTING),undefined);
  assert.equal(readLadder(f.root,'all',BASE+3*HOUR).airportUsage[0].airport,'__unassigned__');
});
test('a broken disposable cache falls back to source records without hiding history',t=>{
  const f=fixture(t),store=f.open('windows');
  record(store,BASE+MINUTE,[connection('retained',11,22)]);
  const broken=path.join(f.root,'not-a-directory');fs.writeFileSync(broken,'synthetic cache failure');
  const result=readLane(f.root,'windows','all',BASE+3*HOUR,{cacheRoot:broken});
  assert.equal(result.available,true);assert.equal(result.allPrograms[0].up,11);assert.equal(result.cacheWarning,'summary_cache_unavailable');
});

test('large connection dictionaries return exact attribution without building an oversized cold cache',t=>{
  const f=fixture(t),store=f.open('windows'),cacheRoot=path.join(f.root,'viewer-cache');initializeArchives(store);
  const count=65001,at=BASE+MINUTE,insert=store.db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?)'),bucket=store.db.prepare('INSERT INTO buckets VALUES(?,?,?,?,?,?)');
  store.db.exec('BEGIN');
  for(let i=0;i<count;i++){const id='large-synthetic-'+i;insert.run(id,'synthetic.example.test','tcp',i%2?'codex.exe':'browser.exe',1,'other','etw',at,at,'{}');bucket.run(at,id,'other',2,3,at);}
  store.db.prepare('INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?)').run(at,1000,0,0,count*2,count*3,0,0,'[]');store.db.exec('COMMIT');
  const progress=[],result=readLane(f.root,'windows','all',BASE+3*HOUR,{cacheRoot,report:value=>progress.push(value)});
  assert.equal(result.available,true);assert.equal(result.detailReady,true);assert.equal(result.allPrograms.reduce((n,r)=>n+r.up,0),count*2);
  assert.equal(result.allPrograms.reduce((n,r)=>n+r.down,0),count*3);assert.equal(result.allPrograms.reduce((n,r)=>n+r.connections,0),count);
  assert.equal(result.familyTotals.codex.up,Math.floor(count/2)*2);assert.equal(fs.existsSync(cacheRoot),false);
  const attribution=progress.filter(value=>value.unit==='identities');
  assert.equal(attribution[0].done,0);assert.equal(attribution[0].total,count);assert.equal(attribution.at(-1).done,count);
  assert(attribution.every((value,index)=>value.total===count&&(!index||value.done>=attribution[index-1].done)));
});

test('an existing SQLite history gains and reuses the compact program index without changing records',async t=>{
  const {randomBytes}=await import('node:crypto'),{Store}=await import('../src/store.mjs');
  const f=fixture(t),dir=path.join(f.root,'windows'),key=randomBytes(32);let store=new Store(dir);
  t.after(()=>{try{store.close();}catch{}key.fill(0);});
  record(store,BASE+MINUTE,[connection('sqlite-identity',12,34,{process:'private-program-canary.exe'})]);
  const before=store.db.prepare('SELECT * FROM connections').all();store.db.exec('DROP INDEX connections_programs');store.close();
  const progress=[];store=new Store(dir,{onProgress:value=>progress.push(value)});
  assert.deepEqual(store.db.prepare('SELECT * FROM connections').all(),before);assert.equal(progress[0].stage,'program_index');
  const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT id,process,evidence FROM connections INDEXED BY connections_programs WHERE id=?').all('sqlite-identity').map(row=>row.detail).join('\n');
  assert.match(plan,/COVERING INDEX connections_programs/);store.close();
  store=new Store(dir,{onProgress:()=>assert.fail('a later opening must reuse the existing index')});store.close();
  assert.equal(fs.readFileSync(path.join(dir,'monitor.sqlite')).subarray(0,15).toString(),'SQLite format 3');
});

test('an empty archive uses the real bucket index for detail lookups',t=>{
  const f=fixture(t),store=f.open('windows');initializeArchives(store);record(store,BASE+MINUTE,[connection('indexed-identity',1,2)]);
  attachArchiveViews(store.db);setArchiveWindows(store.db,[{from:BASE,to:BASE+2*MINUTE}]);
  const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT SUM(up) FROM buckets WHERE connection_id=? AND minute>=? AND minute<?').all('indexed-identity',BASE,BASE+2*MINUTE).map(r=>r.detail).join('\n');
  assert.match(plan,/SEARCH .*buckets.*(connection|INDEX)/i);assert.doesNotMatch(plan,/UNION|MATERIALIZE|SCAN .*buckets/i);
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
test('query progress tracks the selected range, real counters, queues and completion without exposing query payloads',async()=>{
  const worker=new FakeWorker(),reader=new HistoryReader({}, {createWorker:()=>worker});
  try{
    const first=reader.query({type:'overview',range:'today',options:{privateValue:'synthetic-canary'}});
    const queued=reader.query({type:'overview',range:'7d'});
    const waiting=reader.progressFor({type:'overview',range:'7d'});assert.equal(waiting.state,'queued');assert.equal(waiting.position,1);assert.equal(waiting.ahead,0);assert.equal(waiting.blocker.stage,'opening');
    worker.emit('message',{id:worker.sent.at(-1).id,event:'progress',stage:'programs',lane:'windows',done:2048,total:4096,unit:'identities'});
    const progress=reader.progressFor({type:'overview',range:'today'});
    assert.equal(progress.done,2048);assert.equal(progress.total,4096);assert.equal(progress.stage,'programs');assert.equal(progress.state,'running');
    assert.equal(JSON.stringify(progress).includes('synthetic-canary'),false);
    assert.equal(reader.progressFor({type:'overview',range:'day',date:'2026-11-10'}).state,'idle');
    worker.complete();await first;assert.equal(reader.progressFor({type:'overview',range:'today'}).state,'complete');
    worker.complete();await queued;
  }finally{reader.close();}
});
test('a query timeout terminates its worker and the next request recovers without a service restart', async()=>{
  const workers=[];const reader=new HistoryReader({}, {timeoutMs:30,createWorker:()=>{const w=new FakeWorker();workers.push(w);return w;}});
  try{
    await assert.rejects(reader.query({range:'all'}),/history_timeout/);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(workers[0].terminated,true);
    assert.equal(reader.stats().lastError,'history_timeout');assert.equal(reader.stats().failed,1);
    const next=reader.query({range:'today'});workers[1].complete({recovered:true});assert.deepEqual(await next,{recovered:true});
    assert.equal(reader.stats().restarts,1);assert.equal(reader.stats().lastError,null);
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

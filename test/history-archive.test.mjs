import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { DatabaseSync } from '../src/database.mjs';
import { initializeArchives,archiveBatch,attachArchiveViews,deleteArchivedWindows,archivedSampleExists,archiveSummary,historyBounds,setArchiveWindows } from '../src/history-archive.mjs';
import { readLane,readDetail,readHarness } from '../src/overview-data.mjs';
import { storageSnapshot,saveStoragePolicy,archiveOldHistory } from '../src/storage-manager.mjs';
import { prepareCacheFile,sqliteBytes,limitCacheConnection,CACHE_BUDGET,removeSummaryCache } from '../src/storage-files.mjs';

const at=day=>Date.parse(day+'T12:00:00+08:00'),now=at('2026-11-14'),minute=60000;
function sample(timestamp,index=0){
  const scope=index%3===0?'unknown':index%3===1?'codex':'other';
  return {at:timestamp,duration:1000,allUp:100+index,allDown:300+index,codexUp:scope==='codex'?100+index:0,codexDown:scope==='codex'?300+index:0,unknownUp:scope==='unknown'?100+index:0,unknownDown:scope==='unknown'?300+index:0,activeSessions:['synthetic-session'],rows:[{
    key:'synthetic-connection-'+index%4,host:'archive-canary-'+index%4+'.example.test',network:'tcp',process:index%3===1?'codex.exe':'synthetic.exe',pid:10+index%4,scope,evidence:'etw',rule:JSON.stringify({source:'mihomo',chains:index%2?['Synthetic node']:['DIRECT'],destinationIP:'192.0.2.1'}),up:100+index,down:300+index}]};
}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-archive-')),key=Buffer.alloc(32),stores=[];
  for(const lane of ['windows','clash']){
    const store=new Store(path.join(root,lane));initializeArchives(store);stores.push(store);
    for(const day of ['2026-06-09','2026-06-10','2026-06-11','2026-07-01','2026-11-14'])for(let i=0;i<15;i++)store.record(sample(at(day)+i*minute,i));
    const gap=store.openGap('collector_restart',at('2026-06-10')+minute);store.closeGap(gap,at('2026-06-10')+minute*2);
    store.saveSession({id:'synthetic-session',title:'Synthetic session',activity:at('2026-06-10')});
  }

  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10});
  });
  return {root,key,stores};
}
const clean=value=>JSON.parse(JSON.stringify(value,(key,value)=>key==='queryMs'?undefined:value));

test('lossless monthly compression preserves complete overview, exact peaks, routes, unknown scopes and every detail filter',t=>{
  const {root,stores,key}=fixture(t),before=[];
  for(const lane of ['windows','clash']){
    for(const options of [{},{family:'codex'},{scope:'unknown'},{process:'synthetic.exe'},{host:'archive-canary-1.example.test'},{route:'proxy'}])before.push(clean(readDetail(root,lane,'all',now,{...options})));
    before.push(clean(readLane(root,lane,'all',now)));
    before.push(clean(readLane(root,lane,'day',now,{date:'2026-06-10'})));
    before.push(clean(readHarness(root,lane,'all',now,{family:'codex'})));
  }
  for(const store of stores){let batch;do{batch=archiveBatch(store,at('2026-08-01'),{limit:7});}while(batch.moved);}
  let i=0;
  for(const lane of ['windows','clash']){
    for(const options of [{},{family:'codex'},{scope:'unknown'},{process:'synthetic.exe'},{host:'archive-canary-1.example.test'},{route:'proxy'}])assert.deepEqual(clean(readDetail(root,lane,'all',now,{...options})),before[i++]);
    assert.deepEqual(clean(readLane(root,lane,'all',now)),before[i++]);
    assert.deepEqual(clean(readLane(root,lane,'day',now,{date:'2026-06-10'})),before[i++]);
    assert.deepEqual(clean(readHarness(root,lane,'all',now,{family:'codex'})),before[i++]);
  }
  const summary=archiveSummary(stores[0].db);assert.equal(summary.months.length,2);assert.equal(summary.rows,120);assert.ok(summary.compressedBytes<summary.rawBytes);
  assert.equal(stores[0].db.prepare('SELECT COUNT(*) count FROM samples').get().count,15);
  assert.equal(stores[0].record(sample(at('2026-06-10'),0)),false,'replayed archived timestamp must not change totals');
  assert.equal(historyBounds(stores[0].db).firstAt,at('2026-06-09'));
});

test('an abrupt process exit during archive publication leaves committed history recoverable on disk',t=>{
  const {root,stores,key}=fixture(t),dir=path.join(root,'windows');
  const code=`import {Store} from ${JSON.stringify(new URL('../src/store.mjs',import.meta.url).href)};
    import {initializeArchives,archiveBatch} from ${JSON.stringify(new URL('../src/history-archive.mjs',import.meta.url).href)};
    const store=new Store(process.argv[1]);
    initializeArchives(store);archiveBatch(store,${at('2026-08-01')},{beforeCommit(){process.exit(73);}});`;
  const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',code,dir,key.toString('hex')],{windowsHide:true,encoding:'utf8',timeout:10000});
  assert.equal(result.status,73,result.stderr);
  const check=new DatabaseSync(path.join(dir,'monitor.sqlite'));
  try{assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(check.prepare('SELECT COUNT(*) count FROM samples').get().count,75);assert.equal(archiveSummary(check).rows,0);}finally{check.close();}
  assert.ok(archiveBatch(stores[0],at('2026-08-01')).moved);
});

test('interrupted publication rolls back source removal and can resume; corrupted payload fails closed',t=>{
  const {stores}=fixture(t),store=stores[0],db=store.db;
  assert.throws(()=>archiveBatch(store,at('2026-08-01'),{beforeCommit(){throw new Error('synthetic interruption');}}),/interruption/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM samples').get().count,75);assert.equal(archiveSummary(db).rows,0);
  assert.ok(archiveBatch(store,at('2026-08-01')).moved);
  const first=db.prepare('SELECT * FROM vault_archive_chunks LIMIT 1').get();
  db.prepare('UPDATE vault_archive_chunks SET payload=? WHERE id=?').run(Buffer.from('bad compressed data'),first.id);
  attachArchiveViews(db);assert.throws(()=>db.prepare('SELECT SUM(all_up) total FROM samples').get());
});

test('partial archived deletion leaves other minutes exactly intact and can be rolled back atomically',t=>{
  const {stores}=fixture(t),store=stores[0],db=store.db;
  while(archiveBatch(store,at('2026-08-01')).moved){}
  const windows=[{from:at('2026-06-10')+minute,to:at('2026-06-10')+4*minute}],before=archiveSummary(db).rows;
  db.exec('BEGIN');deleteArchivedWindows(db,windows);db.exec('ROLLBACK');assert.equal(archiveSummary(db).rows,before);
  db.exec('BEGIN');deleteArchivedWindows(db,windows);db.exec('COMMIT');attachArchiveViews(db);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM samples').get().count,72);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM buckets WHERE minute>=? AND minute<?').get(windows[0].from,windows[0].to).count,0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM buckets WHERE minute=?').get(at('2026-06-10')+4*minute).count,1);
});

test('archived duplicate timestamps are cached, and archive edits invalidate the replay cache',t=>{
  const {stores}=fixture(t),store=stores[0],timestamp=at('2026-06-10')+minute;
  while(archiveBatch(store,at('2026-08-01')).moved){}
  assert.equal(archivedSampleExists(store.db,timestamp),true);
  assert.equal(archivedSampleExists(store.db,timestamp),true);
  store.db.exec('BEGIN');deleteArchivedWindows(store.db,[{from:timestamp,to:timestamp+1}]);store.db.exec('COMMIT');
  assert.equal(archivedSampleExists(store.db,timestamp),false);
});

test('archive reads prune unrelated blocks before decoding',t=>{
  const {root,stores}=fixture(t),store=stores[0];
  while(archiveBatch(store,at('2026-08-01')).moved){}
  store.db.prepare("UPDATE vault_archive_chunks SET payload=? WHERE month='2026-06'").run(Buffer.from('intentionally unreadable unrelated blocks'));
  const recent=readLane(root,'windows','today',now+minute);assert.equal(recent.available,true);assert.equal(recent.totals.samples,1);
  const july=readDetail(root,'windows','day',now,{date:'2026-07-01'});assert.equal(july.available,true);assert.equal(july.summary.up,1605);
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
});

test('storage policy never deletes old details; status accounts for backups, reusable pages and bounded cache',async t=>{
  const {root,stores}=fixture(t),map=new Map([['windows',stores[0]],['clash',stores[1]]]);
  const policy=saveStoragePolicy(map,{enabled:true,onlineDays:90});assert.equal(policy.retention,'forever');
  const result=await archiveOldHistory(map,{now,delayMs:0});assert.equal(result.moved,240);
  const snapshot=storageSnapshot(root,map,null,now);assert.equal(snapshot.detailsRetained,'forever');assert.equal(snapshot.dailyGrowthBytes,null);assert.ok(snapshot.databaseBytes>0);assert.equal(snapshot.policy.cacheBytes,CACHE_BUDGET);
  const cacheFile=path.join(root,'viewer-cache','windows-programs-v2.sqlite');fs.mkdirSync(path.dirname(cacheFile));
  const cache=new DatabaseSync(cacheFile);limitCacheConnection(cache);const page=cache.prepare('PRAGMA page_size').get().page_size;assert.ok(cache.prepare('PRAGMA max_page_count').get().max_page_count*page<=96*1024**2);cache.close();
  const fd=fs.openSync(cacheFile,'r+');fs.ftruncateSync(fd,97*1024**2);fs.closeSync(fd);prepareCacheFile(cacheFile);assert.equal(sqliteBytes(cacheFile),0);
  assert.throws(()=>removeSummaryCache(path.join(root,'monitor.sqlite')),/invalid_cache_path/);
});

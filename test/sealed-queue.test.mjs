import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.mjs';
import {SealedStore,initializeImport,drainIngestBatch} from '../src/sealed-store.mjs';
import {DiagnosticHistory,DiagnosticSpool} from '../src/ai-diagnostic-store.mjs';
import {createVaultKeys,sealPacket,packetFormat} from '../src/vault-crypto.mjs';
import {vaultKeyEntries} from '../src/vault-migration.mjs';
import {importProgressText} from '../public/vault-browser.mjs';
import {configureDatabaseKeys,DatabaseSync as HistoryDatabase} from '../src/database.mjs';
import {readLane} from '../src/overview-data.mjs';

const base=1770000000000;
const sample=i=>({at:base+i*1000,duration:1000,codexUp:0,codexDown:0,allUp:17,allDown:29,unknownUp:0,unknownDown:0,activeSessions:[],rows:[{key:'synthetic',host:'queue-canary.example.test',network:'tcp',process:'synthetic.exe',pid:5,scope:'other',evidence:'etw',rule:'test',up:17,down:29}]});
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-sealed-queue-')),{metadata,secrets}=await createVaultKeys('synthetic-queue-password');
  const dir=path.join(root,'windows'),key=vaultKeyEntries(root,secrets)[0][1],store=new Store(dir,{filename:'history.vault.sqlite',encryptionKey:key});store.vaultDir=dir;store.vaultLane='windows';initializeImport(store);
  const captured=new SealedStore(dir,metadata),spool=new DatabaseSync(path.join(dir,'ingest.sqlite'));
  t.after(()=>{spool.close();captured.close();store.close();key.fill(0);assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('tw-sealed-queue-'));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return {root,dir,key,store,captured,spool,metadata,secrets};
}

test('a rejected packet rolls back its partial operations and preserves the committed prefix and remaining queue',async t=>{
  const f=await fixture(t);f.captured.record(sample(0));
  const id=crypto.randomUUID(),packet=sealPacket([{method:'record',args:[sample(1)]},{method:'invalid-operation',args:[]}],f.metadata.publicKey,{format:packetFormat,vault:f.metadata.id,lane:'windows',id});
  f.spool.prepare('INSERT INTO envelopes(id,payload) VALUES (?,?)').run(id,Buffer.from(JSON.stringify(packet)));f.captured.record(sample(2));
  assert.throws(()=>drainIngestBatch(f.store,f.metadata,f.secrets,{includeRemaining:true}),error=>error.message==='invalid_ingest_operation'&&error.importedCount===1&&error.remaining===2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) count FROM samples').get().count,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) count FROM vault_imports').get().count,1);
  assert.equal(f.spool.prepare('SELECT COUNT(*) count FROM envelopes').get().count,2);
  f.spool.prepare('DELETE FROM envelopes WHERE id=?').run(id);
  assert.deepEqual(drainIngestBatch(f.store,f.metadata,f.secrets,{includeRemaining:true}),{count:1,pending:false,remaining:0});
  assert.equal(f.store.db.prepare('SELECT SUM(all_up) up FROM samples').get().up,34);assert.equal(f.store.db.prepare('SELECT SUM(up) up FROM buckets').get().up,34);
});

test('process exit after the encrypted commit leaves every source packet replayable without adding bytes twice',async t=>{
  const f=await fixture(t);for(let i=0;i<4;i++)f.captured.record(sample(i));
  const code=`import {Store} from ${JSON.stringify(new URL('../src/store.mjs',import.meta.url).href)};
    import {initializeImport,drainIngestBatch} from ${JSON.stringify(new URL('../src/sealed-store.mjs',import.meta.url).href)};
    import {vaultKeyEntries} from ${JSON.stringify(new URL('../src/vault-migration.mjs',import.meta.url).href)};
    const {metadata,secrets}=JSON.parse(process.env.TW_SYNTHETIC_VAULT),root=process.argv[1],key=vaultKeyEntries(root,secrets)[0][1],store=new Store(root+'/windows',{filename:'history.vault.sqlite',encryptionKey:key});store.vaultDir=root+'/windows';store.vaultLane='windows';initializeImport(store);
    const exec=store.db.exec.bind(store.db);store.db.exec=sql=>{const result=exec(sql);if(sql==='COMMIT')process.exit(73);return result;};
    drainIngestBatch(store,metadata,secrets);`;
  const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',code,f.root],{windowsHide:true,encoding:'utf8',timeout:10000,env:{...process.env,TW_SYNTHETIC_VAULT:JSON.stringify({metadata:f.metadata,secrets:f.secrets})}});
  assert.equal(result.status,73,result.stderr);assert.equal(f.store.db.prepare('SELECT SUM(all_up) up FROM samples').get().up,68);assert.equal(f.spool.prepare('SELECT COUNT(*) count FROM envelopes').get().count,4);
  assert.deepEqual(drainIngestBatch(f.store,f.metadata,f.secrets,{includeRemaining:true}),{count:4,pending:false,remaining:0});
  assert.equal(f.store.db.prepare('SELECT SUM(all_up) up FROM samples').get().up,68);assert.equal(f.store.db.prepare('SELECT SUM(up) up FROM buckets').get().up,68);assert.equal(f.store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(fs.readFileSync(path.join(f.dir,'history.vault.sqlite')).includes(Buffer.from('queue-canary.example.test')),false);
});

test('diagnostic import rejects a partially valid packet atomically while retaining earlier signed evidence',async t=>{
  const f=await fixture(t),signing=crypto.generateKeyPairSync('ed25519');f.metadata.capturePublicKey=signing.publicKey.export({format:'pem',type:'spki'});
  const history=new DiagnosticHistory(f.root,f.metadata,f.secrets),captured=new DiagnosticSpool(f.root,f.metadata,{signingKey:signing.privateKey}),spool=new DatabaseSync(path.join(f.root,'diagnostics','ingest.sqlite'));
  try{
    captured.append([{id:'good',kind:'request',at:base,category:'success'}]);captured.append([{id:'partial',kind:'request',at:base+1000},{id:'rejected',kind:'unsupported',at:base+1000}]);
    assert.throws(()=>history.drainBatch({includeRemaining:true}),error=>error.message==='invalid_diagnostic_event'&&error.importedCount===1&&error.remaining===1);
    assert.deepEqual(history.db.prepare('SELECT id FROM events').all().map(row=>row.id),['good']);assert.equal(spool.prepare('SELECT COUNT(*) count FROM envelopes').get().count,1);
  }finally{spool.close();captured.close();history.close();}
});

test('import notices distinguish queued history, actual import failures and normal live capture',()=>{
  assert.equal(importProgressText({state:'complete'}),'');assert.equal(importProgressText({state:'running',remaining:1}),'');
  const progress={state:'running',remaining:30,processed:70,packetsPerSecond:40,lanes:{windows:{remaining:20},clash:{remaining:10},diagnostics:{remaining:0}}};
  const text=importProgressText(progress);assert.match(text,/本机 20 批/);assert.match(text,/梯子 10 批/);assert.match(text,/已补齐 70 批/);assert.match(text,/40 批\/秒/);
  const paused=importProgressText({...progress,state:'paused',lane:'windows',lanes:{windows:{remaining:20,error:'packet_validation_failed'}}});assert.match(paused,/校验未通过/);assert.match(paused,/继续加密保留/);assert.doesNotMatch(paused,/正在将/);
});

test('late encrypted capture invalidates completed-hour program summaries without changing the selected range',async t=>{
  const f=await fixture(t),cacheRoot=path.join(f.root,'viewer-cache'),now=base+4*3600000;
  configureDatabaseKeys(vaultKeyEntries(f.root,f.secrets,cacheRoot));t.after(()=>configureDatabaseKeys([]));
  f.captured.record(sample(0));f.captured.record(sample(10800));drainIngestBatch(f.store,f.metadata,f.secrets);
  const read=cached=>readLane(f.root,'windows','all',now,{vault:true,from:base,to:now,...(cached?{cacheRoot}:{})});
  const before=read(true);assert.equal(before.allPrograms[0].up,34);assert(fs.existsSync(path.join(cacheRoot,'windows-programs-v2.sqlite')));
  f.captured.record(sample(3600));drainIngestBatch(f.store,f.metadata,f.secrets);
  const after=read(true),direct=read(false);assert.deepEqual(after.allPrograms,direct.allPrograms);assert.equal(after.allPrograms[0].up,51);assert.equal(after.totals.up,51);assert.equal(after.unassigned.up,0);assert.deepEqual(after.range,before.range);
  const legacyCache=new HistoryDatabase(path.join(cacheRoot,'windows-programs-v2.sqlite'));
  try{legacyCache.exec("DELETE FROM state WHERE key='format';UPDATE usage_hourly SET up=0,down=0;UPDATE program_bases SET value='[]'");}finally{legacyCache.close();}
  assert.deepEqual(read(true).allPrograms,direct.allPrograms,'upgrading also rebuilds an incomplete cache left by an older importer');
});

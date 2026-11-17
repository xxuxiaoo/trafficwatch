import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { createVaultKeys } from '../src/vault-crypto.mjs';
import { migrateLane,vaultKeyEntries } from '../src/vault-migration.mjs';
import { SealedStore,initializeImport,drainIngest,drainIngestBatch,importEnvelope } from '../src/sealed-store.mjs';
import { DatabaseSync as PlainDatabase } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from '../src/database.mjs';

const sample=at=>({at,duration:1000,codexUp:0,codexDown:0,allUp:17,allDown:29,unknownUp:0,unknownDown:0,activeSessions:[],rows:[{key:'synthetic-connection',host:'vault-canary.example.test',network:'tcp',process:'synthetic.exe',pid:5,scope:'other',evidence:'etw',rule:'test',up:17,down:29}]});
test('plaintext history migrates without changing totals and sealed capture imports exactly once',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-vault-storage-')),lane=path.join(dir,'windows');
  let encrypted,sealed;
  try{
    const original=new Store(lane);original.record(sample(1770000000000));original.close();
    const {metadata,secrets}=await createVaultKeys('synthetic-only-password');
    const key=vaultKeyEntries(dir,secrets)[0][1];
    encrypted=await migrateLane(dir,'windows',key);encrypted.vaultLane='windows';encrypted.vaultDir=lane;initializeImport(encrypted);
    assert.equal(encrypted.totals(0,Date.now()).all_up,17);
    sealed=new SealedStore(lane,metadata);const gap=sealed.openGap('collector_restart',1770000001000);sealed.closeGap(gap,1770000002000);sealed.record(sample(1770000002000));sealed.flush();
    const spool=new PlainDatabase(path.join(lane,'ingest.sqlite'));
    const envelope=spool.prepare('SELECT * FROM envelopes LIMIT 1').get();spool.close();
    assert.equal(importEnvelope(encrypted,envelope,metadata,secrets),true);
    assert.equal(importEnvelope(encrypted,envelope,metadata,secrets),false);
    assert.equal(drainIngest(encrypted,metadata,secrets),1);
    assert.equal(encrypted.totals(0,Date.now()).all_up,34);
    assert.equal(encrypted.connections(0,Date.now(),'all')[0].up,34);
    assert.equal(encrypted.db.prepare('SELECT COUNT(*) count FROM collection_gaps').get().count,1);
    encrypted.close();encrypted=null;sealed.close();sealed=null;
    const reopened=await migrateLane(dir,'windows',key);assert.equal(reopened.totals(0,Date.now()).all_down,58);reopened.close();
    for(const file of ['history.vault.sqlite','ingest.sqlite'])assert.equal(fs.readFileSync(path.join(lane,file)).includes(Buffer.from('vault-canary.example.test')),false);
    const wrongReader=new PlainDatabase(path.join(lane,'history.vault.sqlite'));
    try{assert.throws(()=>wrongReader.prepare('SELECT * FROM samples').all());}finally{wrongReader.close();}
  }finally{encrypted?.close();sealed?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('completed histories become ready before a backlog drains, then import in the background without a first migration',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-vault-reopen-'));let worker;
  try{
    const {metadata,secrets}=await createVaultKeys('synthetic-reopen-password');metadata.cleanupComplete=true;
    const entries=vaultKeyEntries(dir,secrets);
    for(const lane of ['windows','clash']){const key=entries.find(([file])=>file.includes(path.sep+lane+path.sep))[1];const store=await migrateLane(dir,lane,key);store.close();}
    const captured=new SealedStore(path.join(dir,'windows'),metadata);
    for(let i=0;i<121;i++)captured.record(sample(1770000000000+i*1000));captured.close();
    const progress=[];let queueAtReady,queryWhilePending=false;
    worker=new Worker(new URL('../src/vault-writer.mjs',import.meta.url),{workerData:{dataRoot:dir,metadata,secrets}});
    await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('synthetic initialization timeout')),15000);worker.on('error',reject);worker.on('message',message=>{
      try{
      if(message.event==='progress')progress.push(message);
      if(message.event==='failed'){clearTimeout(timeout);reject(new Error(message.error));}
      if(message.event==='ready'){
        const spool=new PlainDatabase(path.join(dir,'windows','ingest.sqlite'),{readOnly:true});try{queueAtReady=spool.prepare('SELECT COUNT(*) count FROM envelopes').get().count;}finally{spool.close();}
        assert(queueAtReady>0,'ready must not wait for the capture backlog');
        worker.postMessage({id:1,action:'notes',lane:'clash',windows:[{from:0,to:Math.ceil(Date.now()/60000)*60000}]});
      }
      if(message.id===1){
        assert.equal(message.error,undefined);assert.deepEqual(message.result,[]);
        const spool=new PlainDatabase(path.join(dir,'windows','ingest.sqlite'),{readOnly:true});try{queryWhilePending=spool.prepare('SELECT COUNT(*) count FROM envelopes').get().count>0;}finally{spool.close();}
      }
      if(message.event==='import-progress'&&message.state==='complete'){clearTimeout(timeout);resolve();}
      }catch(error){clearTimeout(timeout);reject(error);}
    });});
    assert.ok(progress.some(p=>p.phase==='opening'));assert.equal(progress.some(p=>p.phase==='migration'),false);assert.equal(queryWhilePending,true);
    await worker.terminate();worker=null;
    const db=new DatabaseSync(entries[0][0],{readOnly:true,encryptionKey:entries[0][1]});
    try{assert.equal(db.prepare('SELECT COUNT(*) count FROM samples').get().count,121);assert.equal(db.prepare('SELECT SUM(all_up) up FROM samples').get().up,121*17);}finally{db.close();}
  }finally{await worker?.terminate();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('a timed import slice leaves resumable envelopes and does not double totals on the next slice',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-import-slice-'));let store,captured;
  try{
    const {metadata,secrets}=await createVaultKeys('synthetic-slice-password');const key=vaultKeyEntries(dir,secrets)[0][1];
    store=await migrateLane(dir,'windows',key);store.vaultLane='windows';store.vaultDir=path.join(dir,'windows');initializeImport(store);
    captured=new SealedStore(store.vaultDir,metadata,{maxPendingOperations:2});for(let i=0;i<4;i++)captured.record(sample(1770000000000+i*1000));captured.close();captured=null;
    assert.deepEqual(drainIngestBatch(store,metadata,secrets,{limit:4,maxMs:0}),{count:1,pending:true});
    assert.deepEqual(drainIngestBatch(store,metadata,secrets,{limit:4,maxMs:1000}),{count:1,pending:false});
    assert.equal(store.totals(0,Date.now()).all_up,4*17);
  }finally{captured?.close();store?.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

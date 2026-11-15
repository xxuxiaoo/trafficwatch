import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from '../src/store.mjs';
import { cleanupLegacy,verifyCleanupBackup } from '../src/vault-cleanup.mjs';
import { VaultService } from '../src/vault-service.mjs';

function fixture(t){
  const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'tw-cleanup-')),stores=new Map(),entries=[];
  fs.mkdirSync(path.join(dataRoot,'vault'),{recursive:true});
  for(const lane of ['windows','clash']){
    const dir=path.join(dataRoot,lane),key=crypto.randomBytes(32),store=new Store(dir,{filename:'history.vault.sqlite',encryptionKey:key});
    store.record({at:1770000000000,duration:1000,allUp:11,allDown:37,codexUp:0,codexDown:0,unknownUp:0,unknownDown:0,activeSessions:[],rows:[{key:'canary',host:'PRIVATE-CLEANUP-CANARY.example.test',network:'tcp',process:'test.exe',pid:1,scope:'other',evidence:'etw',rule:'{}',up:11,down:37}]});
    fs.writeFileSync(path.join(dir,'monitor.sqlite'),'synthetic legacy placeholder');
    entries.push([path.join(dir,'history.vault.sqlite'),key]);stores.set(lane,store);
  }
  t.after(()=>{for(const store of stores.values())store.close();for(const [,key] of entries)key.fill(0);fs.rmSync(dataRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  return {dataRoot,stores,entries};
}

test('every encrypted backup must verify before either plaintext lane is removed; retry reuses verified snapshots',t=>{
  const context=fixture(t),phases=[];
  assert.throws(()=>cleanupLegacy({...context,progress:value=>phases.push(value),verify:(file,key,expected)=>{
    if(path.basename(file).startsWith('clash-'))throw new Error('synthetic second-lane verification failure');
    verifyCleanupBackup(file,key,expected);
  }}),/synthetic second-lane/);
  for(const lane of ['windows','clash'])assert.equal(fs.existsSync(path.join(context.dataRoot,lane,'monitor.sqlite')),true);
  const backupDir=path.join(context.dataRoot,'vault','backups'),windowsFile=path.join(backupDir,'windows-before-plaintext-cleanup.sqlite');
  const originalHash=crypto.createHash('sha256').update(fs.readFileSync(windowsFile)).digest('hex');
  assert.equal(fs.readFileSync(windowsFile).includes(Buffer.from('PRIVATE-CLEANUP-CANARY')),false);
  assert.equal(context.stores.get('windows').get('cleanupVerifiedBackup').name,path.basename(windowsFile));
  const result=cleanupLegacy({...context,progress:value=>phases.push(value)});assert.equal(result.ok,true);
  for(const lane of ['windows','clash'])assert.equal(fs.existsSync(path.join(context.dataRoot,lane,'monitor.sqlite')),false);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(windowsFile)).digest('hex'),originalHash);
  assert.equal(fs.readdirSync(backupDir).filter(name=>name.endsWith('.sqlite')).length,2);
  assert.equal(phases.at(-1).stage,'remove');
});

test('busy WAL checkpoint refuses backup and preserves all plaintext',t=>{
  const context=fixture(t),original=context.stores.get('windows'),fake=Object.create(original);
  fake.db={prepare:sql=>{assert.equal(sql,'PRAGMA wal_checkpoint(TRUNCATE)');return {get:()=>({busy:1})};}};
  fake.get=()=>null;const stores=new Map(context.stores);stores.set('windows',fake);
  assert.throws(()=>cleanupLegacy({...context,stores}),/vault_backup_busy/);
  for(const lane of ['windows','clash'])assert.equal(fs.existsSync(path.join(context.dataRoot,lane,'monitor.sqlite')),true);
});

test('cleanup submission returns immediately, coalesces repeat clicks and finishes without the initiating HTTP client',async t=>{
  const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'tw-cleanup-job-'));fs.mkdirSync(path.join(dataRoot,'vault'));
  const vault=new VaultService({dataRoot,ownerSid:'synthetic',guardFactory:callback=>({start(){callback({state:'unlocked'});},close(){}})});
  t.after(()=>{vault.close();fs.rmSync(dataRoot,{recursive:true,force:true});});
  vault.metadata={id:'synthetic',cleanupComplete:false};vault.ready=true;vault.locked=false;vault.writer={terminate(){}};
  let finish,calls=0;
  vault.callWriter=request=>request.action==='cleanup'?(calls++,new Promise(resolve=>{finish=resolve;})):Promise.resolve();
  const first=vault.startCleanup();assert.equal(first.state,'running');assert.equal(calls,1);
  assert.deepEqual(vault.startCleanup(),first);assert.equal(calls,1);
  assert.equal(vault.status().plaintextCleanupPending,true);
  finish({ok:true});await vault.cleanupPromise;
  assert.equal(vault.status().cleanup.state,'completed');assert.equal(vault.status().plaintextCleanupPending,false);
  assert.equal(vault.startCleanup().state,'completed');assert.equal(calls,1);
});

test('interruption is reported as paused and an unlocked owner can retry without claiming success',async t=>{
  const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'tw-cleanup-pause-'));fs.mkdirSync(path.join(dataRoot,'vault'));
  const vault=new VaultService({dataRoot,ownerSid:'synthetic',guardFactory:callback=>({start(){callback({state:'unlocked'});},close(){}})});
  t.after(()=>{vault.close();fs.rmSync(dataRoot,{recursive:true,force:true});});
  vault.metadata={cleanupComplete:false};vault.ready=true;vault.writer={terminate(){}};
  vault.callWriter=()=>Promise.reject(new Error('vault_locked'));
  vault.startCleanup();await vault.cleanupPromise;
  assert.equal(vault.status().cleanup.state,'paused');assert.equal(vault.status().plaintextCleanupPending,true);
  vault.callWriter=()=>Promise.resolve({ok:true});vault.startCleanup();await vault.cleanupPromise;
  assert.equal(vault.status().cleanup.state,'completed');
});

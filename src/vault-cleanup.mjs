import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from './database.mjs';

const totals = db => db.prepare('SELECT COUNT(*) count,SUM(all_up) up,SUM(all_down) down FROM samples').get();

export function verifyCleanupBackup(file,key,expected){
  const restore=new DatabaseSync(file,{readOnly:true,encryptionKey:key});
  try{
    // Full integrity checking visits both tables and indexes. A 2 MiB default
    // cache causes severe page/decryption churn on multi-gigabyte histories.
    restore.exec('PRAGMA query_only=ON;PRAGMA cache_size=-65536;PRAGMA temp_store=MEMORY');
    if(restore.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||JSON.stringify(totals(restore))!==JSON.stringify(expected))throw new Error('vault_backup_verification_failed');
  }finally{restore.close();}
}

export function cleanupLegacy({dataRoot,stores,entries,progress=()=>{},verify=verifyCleanupBackup}){
  const backupDir=path.join(dataRoot,'vault','backups');fs.mkdirSync(backupDir,{recursive:true});
  // Verify every lane before deleting any legacy database. A crash after a
  // verified copy can reuse its encrypted receipt rather than pile up copies.
  for(const [lane,store] of stores){
    const key=entries.find(([filename])=>filename===path.join(dataRoot,lane,'history.vault.sqlite'))?.[1];
    if(!key)throw new Error('vault_backup_key_unavailable');
    let receipt=store.get('cleanupVerifiedBackup',null),backup;
    if(receipt&&/^\w+-before-plaintext-cleanup\.sqlite$/.test(receipt.name)){
      backup=path.join(backupDir,receipt.name);
      if(!fs.existsSync(backup))receipt=null;
    }else receipt=null;
    if(!receipt){
      progress({stage:'checkpoint',lane});
      const checkpoint=store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if(checkpoint.busy!==0)throw new Error('vault_backup_busy');
      const expected=totals(store.db),name=lane+'-before-plaintext-cleanup.sqlite';
      backup=path.join(backupDir,name);
      const pending=backup+'.pending';
      progress({stage:'copy',lane});
      fs.copyFileSync(path.join(dataRoot,lane,'history.vault.sqlite'),pending);
      progress({stage:'verify',lane});
      verify(pending,key,expected);
      fs.renameSync(pending,backup);
      receipt={name,totals:expected,verifiedAt:Date.now()};
      // This receipt contains traffic counts and therefore stays inside the
      // encrypted history database, never in a plaintext manifest.
      store.set('cleanupVerifiedBackup',receipt);
    }else{
      progress({stage:'verify',lane});verify(backup,key,receipt.totals);
    }
  }
  progress({stage:'remove',lane:null});
  for(const lane of stores.keys())for(const suffix of ['','-wal','-shm']){
    const old=path.join(dataRoot,lane,'monitor.sqlite'+suffix);if(fs.existsSync(old))fs.unlinkSync(old);
  }
  for(const suffix of ['','-wal','-shm']){
    const old=path.join(dataRoot,'viewer-cache','windows-programs-v2.sqlite'+suffix);if(fs.existsSync(old))fs.unlinkSync(old);
  }
  return {ok:true,message:'已验证两路加密备份可恢复，并清理当前数据目录的旧明文数据库与摘要缓存。'};
}

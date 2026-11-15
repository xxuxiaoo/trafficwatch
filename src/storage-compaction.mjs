import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from './database.mjs';
import { availableDisk,sqliteBytes,fileBytes } from './storage-files.mjs';

const ident=name=>'"'+name.replaceAll('"','""')+'"';
const yieldTurn=()=>new Promise(resolve=>setTimeout(resolve,15));

// Startup recovery never trusts an incomplete target. The committed old file is
// the rollback point until the verified new file occupies the normal filename.
export function recoverCompaction(file) {
  const previous=file+'.compact.previous',pending=file+'.compact.pending';
  if(!fs.existsSync(file)&&fs.existsSync(previous))fs.renameSync(previous,file);
  // A completed swap may retain its previous file after an abrupt shutdown.
  // Deletion waits for the next successful keyed open/quick_check (below).
  if(fs.existsSync(file)&&fs.existsSync(pending))for(const suffix of ['','-wal','-shm'])if(fs.existsSync(pending+suffix))fs.unlinkSync(pending+suffix);
}
export function finishRecoveredCompaction(file,db) {
  const previous=file+'.compact.previous';
  if(fs.existsSync(previous)) {
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('vault_compaction_verification_failed');
    fs.unlinkSync(previous);
  }
}

// Rebuild into an explicitly keyed destination, streaming at most 256 rows per
// turn. SQLite VACUUM's large temporary database is deliberately avoided. Import
// pauses while rebuilding; collectors keep sealing packets in their own queue.
export async function compactHistory(store,file,key,{progress=()=>{},beforeSwap}={}) {
  const db=store.db,pending=file+'.compact.pending',previous=file+'.compact.previous';
  const size=sqliteBytes(file),disk=availableDisk(path.dirname(file));
  if(disk.availableBytes!==null&&disk.availableBytes<size+256*1024*1024)throw new Error('vault_storage_space_low');
  const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if(checkpoint.busy)throw new Error('vault_storage_busy');
  recoverCompaction(file);finishRecoveredCompaction(file,db);
  const output=new DatabaseSync(pending,{encryptionKey:key});
  let swapped=false,closed=false;
  try {
    output.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=-16384;PRAGMA foreign_keys=OFF');
    const schema=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY rowid").all();
    for(const entry of schema.filter(entry=>entry.type==='table'))output.exec(entry.sql);
    // Maintain indexes while streaming inserts, avoiding a large plaintext
    // temporary sort (or a huge in-memory sorter) at the end of the rebuild.
    for(const entry of schema.filter(entry=>entry.type==='index'))output.exec(entry.sql);
    for(const entry of schema.filter(entry=>entry.type==='table')) {
      progress({stage:'copy',table:entry.name});
      const columns=db.prepare(`PRAGMA table_info(${ident(entry.name)})`).all().map(row=>row.name);
      const insert=output.prepare(`INSERT INTO ${ident(entry.name)} VALUES (${columns.map(()=>'?').join(',')})`);
      // Cursor stays in the source connection; independent encrypted output
      // transactions and event-loop yields never materialize the full table.
      let count=0,pendingRows=0;
      output.exec('BEGIN');
      try{
        for(const row of db.prepare(`SELECT * FROM ${ident(entry.name)}`).iterate()) {
          insert.run(...columns.map(column=>row[column]));count++;pendingRows++;
          if(pendingRows===256){output.exec('COMMIT');await yieldTurn();output.exec('BEGIN');pendingRows=0;}
        }
        output.exec('COMMIT');
      }catch(error){output.exec('ROLLBACK');throw error;}
      if(output.prepare(`SELECT COUNT(*) count FROM ${ident(entry.name)}`).get().count!==count)throw new Error('vault_compaction_count_mismatch');
      // Counts alone cannot catch a corrupted value or shifted column. Hash all
      // values in rowid order on BOTH sides without logging any of them.
      const hash=async connection=>{
        const result=createHash('sha256');
        let read=0;
        for(const row of connection.prepare(`SELECT * FROM ${ident(entry.name)}`).iterate()) {
          result.update(JSON.stringify(columns.map(column=>Buffer.isBuffer(row[column])?{blob:row[column].toString('base64')}:row[column]))+'\n');
          if(++read%2048===0)await yieldTurn();
        }
        return result.digest('hex');
      };
      if(await hash(db)!==await hash(output))throw new Error('vault_compaction_digest_mismatch');
      await yieldTurn();
    }
    progress({stage:'indexes'});
    for(const entry of schema.filter(entry=>!['table','index'].includes(entry.type))){output.exec(entry.sql);await yieldTurn();}
    output.exec('PRAGMA user_version='+db.prepare('PRAGMA user_version').get().user_version);
    progress({stage:'verify'});
    if(output.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||output.prepare('PRAGMA foreign_key_check').all().length)throw new Error('vault_compaction_verification_failed');
    output.close();closed=true;
    await beforeSwap?.();
    db.close();
    // Both files have no active WAL; never rename an uncheckpointed database.
    fs.renameSync(file,previous);
    try{fs.renameSync(pending,file);swapped=true;}catch(error){fs.renameSync(previous,file);throw error;}
    return {beforeBytes:size,afterBytes:fileBytes(file),reclaimedBytes:Math.max(0,size-fileBytes(file))};
  }finally{
    if(!closed)output.close();
    if(!swapped&&fs.existsSync(pending))fs.unlinkSync(pending);
  }
}

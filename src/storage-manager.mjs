import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync as PlainDatabase } from 'node:sqlite';
import { archiveSummary,archiveBatch,archiveCutoff } from './history-archive.mjs';
import { CACHE_BUDGET,sqliteBytes,fileBytes,directoryUsage,availableDisk,tidyBackupStaging } from './storage-files.mjs';

export const STORAGE_POLICY=Object.freeze({version:1,enabled:true,onlineDays:90,retention:'forever',cacheBytes:CACHE_BUDGET,backupVersionsPerLane:1});
export function storagePolicy(store) { return {...STORAGE_POLICY,...store.get('storagePolicy',{}),retention:'forever',cacheBytes:CACHE_BUDGET,backupVersionsPerLane:1}; }
export function saveStoragePolicy(stores,input) {
  if(![30,90,180,365].includes(input.onlineDays)||typeof input.enabled!=='boolean')throw new Error('invalid_storage_policy');
  const value={...STORAGE_POLICY,enabled:input.enabled,onlineDays:input.onlineDays};
  for(const store of stores.values())store.set('storagePolicy',value);
  return value;
}
export function storageSnapshot(dataRoot,stores,job,now=Date.now()) {
  const lanes=[];let databaseBytes=0,queueBytes=0,reusableBytes=0;
  for(const [lane,store] of stores) {
    const db=store.db,file=path.join(dataRoot,lane,'history.vault.sqlite');
    const page=db.prepare('PRAGMA page_size').get().page_size,free=db.prepare('PRAGMA freelist_count').get().freelist_count;
    const archives=archiveSummary(db),bounds=db.prepare('SELECT MIN(at) firstAt,MAX(at) lastAt FROM samples').get();
    const online=db.prepare('SELECT COUNT(*) rows FROM samples').get().rows;
    const old=db.prepare('SELECT 1 FROM samples WHERE at<? LIMIT 1').get(archiveCutoff(now,storagePolicy(store).onlineDays));
    const oldBucket=db.prepare('SELECT 1 FROM buckets WHERE minute<? LIMIT 1').get(archiveCutoff(now,storagePolicy(store).onlineDays));
    const queueFile=path.join(dataRoot,lane,'ingest.sqlite'),physicalQueue=sqliteBytes(queueFile);
    let pendingPackets=0,pendingBytes=0;
    if(fs.existsSync(queueFile)) {
      const queue=new PlainDatabase(queueFile,{readOnly:true});
      try{queue.exec('PRAGMA busy_timeout=300');const row=queue.prepare('SELECT COUNT(*) count,COALESCE(SUM(length(payload)),0) bytes FROM envelopes').get();pendingPackets=row.count;pendingBytes=row.bytes;}catch{pendingPackets=pendingBytes=null;}finally{queue.close();}
    }
    const physicalBytes=sqliteBytes(file);
    lanes.push({lane,physicalBytes,reusableBytes:free*page,online:{...bounds,samples:online,hasArchiveCandidates:Boolean(old||oldBucket)},archives,
      queue:{physicalBytes:physicalQueue,pendingPackets,pendingBytes}});
    databaseBytes+=physicalBytes;queueBytes+=physicalQueue;reusableBytes+=free*page;
  }
  const cache=directoryUsage(path.join(dataRoot,'viewer-cache')),backups=directoryUsage(path.join(dataRoot,'vault','backups'));
  const backupFiles=[];
  const backupRoot=path.join(dataRoot,'vault','backups');
  if(fs.existsSync(backupRoot))for(const entry of fs.readdirSync(backupRoot,{withFileTypes:true}))if(entry.isFile()) {
    const file=path.join(backupRoot,entry.name);backupFiles.push({name:entry.name,bytes:fileBytes(file),modifiedAt:Math.floor(fs.statSync(file).mtimeMs),managed:/^(windows|clash)-before-plaintext-cleanup\.sqlite$/.test(entry.name)});
  }
  const diagnostic=directoryUsage(path.join(dataRoot,'diagnostics'));
  const totalBytes=databaseBytes+queueBytes+cache.bytes+backups.bytes+diagnostic.bytes;
  const first=stores.values().next().value,day=new Date(now+8*3600000).toISOString().slice(0,10);
  const history=first.get('storageGrowth',[]).filter(point=>point.day>=new Date(now-31*86400000).toISOString().slice(0,10));
  const today=history.find(point=>point.day===day);
  if(!today){history.push({day,at:now,bytes:totalBytes});first.set('storageGrowth',history);}
  const baseline=history.find(point=>now-point.at>=86400000),dailyGrowthBytes=baseline?Math.max(0,(totalBytes-baseline.bytes)/((now-baseline.at)/86400000)):null;
  const disk=availableDisk(dataRoot),daysRemaining=dailyGrowthBytes>0&&disk.availableBytes!==null?Math.floor(disk.availableBytes/dailyGrowthBytes):null;
  const warnings=[];
  if(disk.availableBytes!==null&&(disk.availableBytes<5*1024**3||disk.availableBytes/disk.capacityBytes<0.05))warnings.push('disk_low');
  if(daysRemaining!==null&&daysRemaining<60)warnings.push('capacity_soon');
  if(lanes.some(lane=>(lane.queue.pendingBytes||0)>512*1024**2))warnings.push('queue_backlog');
  if(cache.incomplete||backups.incomplete||diagnostic.incomplete)warnings.push('scan_incomplete');
  return {generatedAt:now,policy:storagePolicy(first),job:job||null,totalBytes,databaseBytes,queueBytes,cacheBytes:cache.bytes,backupBytes:backups.bytes,diagnosticBytes:diagnostic.bytes,
    reusableBytes,lanes,backupFiles,disk,dailyGrowthBytes,daysRemaining,growth:history,warnings,
    archiveFormat:'monthly-deflate-blocks-inside-encrypted-database',detailsRetained:'forever',precision:'unchanged'};
}

export async function archiveOldHistory(stores,{progress=()=>{},now=Date.now(),delayMs=150,shouldStop=()=>false}={}) {
  let moved=0,rawBytes=0,compressedBytes=0;
  for(const [lane,store] of stores) {
    const policy=storagePolicy(store);if(!policy.enabled)continue;
    const cutoff=archiveCutoff(now,policy.onlineDays);
    while(!shouldStop()) {
      const batch=archiveBatch(store,cutoff);
      if(!batch.moved)break;
      moved+=batch.moved;rawBytes+=batch.rawBytes;compressedBytes+=batch.compressedBytes;
      progress({stage:'archive',lane,month:batch.month,moved,rawBytes,compressedBytes});
      await new Promise(resolve=>setTimeout(resolve,delayMs));
    }
    store.db.exec('PRAGMA optimize;PRAGMA wal_checkpoint(PASSIVE)');
  }
  return {moved,rawBytes,compressedBytes,paused:shouldStop()};
}
export {tidyBackupStaging};

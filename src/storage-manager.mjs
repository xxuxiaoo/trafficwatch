import fs from 'node:fs';
import path from 'node:path';
import { historyDirectory, historyFilename } from './history-paths.mjs';
import { archiveSummary,archiveBatch,archiveCutoff } from './history-archive.mjs';
import { CACHE_BUDGET,sqliteBytes,fileBytes,directoryUsage,availableDisk } from './storage-files.mjs';

export const STORAGE_POLICY=Object.freeze({version:1,enabled:true,onlineDays:90,retention:'forever',cacheBytes:CACHE_BUDGET,backupVersionsPerLane:1});
export function storagePolicy(store) { return {...STORAGE_POLICY,...store.get('storagePolicy',{}),retention:'forever',cacheBytes:CACHE_BUDGET,backupVersionsPerLane:1}; }
export function saveStoragePolicy(stores,input) {
  if(![30,90,180,365].includes(input.onlineDays)||typeof input.enabled!=='boolean')throw new Error('invalid_storage_policy');
  const value={...STORAGE_POLICY,enabled:input.enabled,onlineDays:input.onlineDays};
  for(const store of stores.values())store.set('storagePolicy',value);
  return value;
}
export function storageSnapshot(dataRoot,stores,job,now=Date.now()) {
  const lanes=[];let databaseBytes=0,reusableBytes=0;
  for(const [lane,store] of stores) {
    const db=store.db,file=db.location('main');
    const page=db.prepare('PRAGMA page_size').get().page_size,free=db.prepare('PRAGMA freelist_count').get().freelist_count;
    const archives=archiveSummary(db),bounds=db.prepare('SELECT MIN(at) firstAt,MAX(at) lastAt FROM samples').get();
    const online=db.prepare('SELECT COUNT(*) rows FROM samples').get().rows;
    const old=db.prepare('SELECT 1 FROM samples WHERE at<? LIMIT 1').get(archiveCutoff(now,storagePolicy(store).onlineDays));
    const oldBucket=db.prepare('SELECT 1 FROM buckets WHERE minute<? LIMIT 1').get(archiveCutoff(now,storagePolicy(store).onlineDays));
    const physicalBytes=sqliteBytes(file);
    lanes.push({lane,physicalBytes,reusableBytes:free*page,online:{...bounds,samples:online,hasArchiveCandidates:Boolean(old||oldBucket)},archives});
    databaseBytes+=physicalBytes;reusableBytes+=free*page;
  }
  const cache = directoryUsage(path.join(dataRoot, 'viewer-cache'));
  const backups = directoryUsage(path.join(dataRoot, 'vault'));
  const backupFiles = [];
  for (const lane of ['windows', 'clash', 'diagnostics']) {
    for (const name of ['history.vault.sqlite', 'ingest.sqlite']) {
      const file = path.join(dataRoot, lane, name);
      if (fs.existsSync(file)) {
        const bytes = sqliteBytes(file);
        backups.bytes += bytes;
        backupFiles.push({ name: `${lane}/${name}`, bytes, modifiedAt: fs.statSync(file).mtimeMs });
      }
    }
  }
  const oldAttachments = directoryUsage(path.join(dataRoot, 'diagnostics', 'attachments'));
  backups.bytes += oldAttachments.bytes;
  const diagnosticBytes = sqliteBytes(path.join(historyDirectory(dataRoot, 'diagnostics'), historyFilename('diagnostics')));
  const totalBytes = databaseBytes + cache.bytes + backups.bytes + diagnosticBytes;
  const first=stores.values().next().value,day=new Date(now+8*3600000).toISOString().slice(0,10);
  const history=first.get('storageGrowth',[]).filter(point=>point.day>=new Date(now-31*86400000).toISOString().slice(0,10));
  const today=history.find(point=>point.day===day);
  if(!today){history.push({day,at:now,bytes:totalBytes});first.set('storageGrowth',history);}
  const baseline=history.find(point=>now-point.at>=86400000),dailyGrowthBytes=baseline?Math.max(0,(totalBytes-baseline.bytes)/((now-baseline.at)/86400000)):null;
  const disk=availableDisk(dataRoot),daysRemaining=dailyGrowthBytes>0&&disk.availableBytes!==null?Math.floor(disk.availableBytes/dailyGrowthBytes):null;
  const warnings=[];
  if(disk.availableBytes!==null&&(disk.availableBytes<5*1024**3||disk.availableBytes/disk.capacityBytes<0.05))warnings.push('disk_low');
  if(daysRemaining!==null&&daysRemaining<60)warnings.push('capacity_soon');
  if(cache.incomplete||backups.incomplete||oldAttachments.incomplete)warnings.push('scan_incomplete');
  return {generatedAt:now,policy:storagePolicy(first),job:job||null,totalBytes,databaseBytes,cacheBytes:cache.bytes,backupBytes:backups.bytes,diagnosticBytes,
    reusableBytes,lanes,backupFiles,disk,dailyGrowthBytes,daysRemaining,growth:history,warnings,
    archiveFormat:'monthly-deflate-blocks-in-sqlite',detailsRetained:'forever',precision:'unchanged'};
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

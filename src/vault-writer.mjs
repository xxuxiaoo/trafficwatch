import path from 'node:path';
import fs from 'node:fs';
import {DatabaseSync as PlainDatabase} from 'node:sqlite';
import { parentPort,workerData } from 'node:worker_threads';
import { migrateLane,vaultKeyEntries } from './vault-migration.mjs';
import { initializeImport,drainIngestBatch } from './sealed-store.mjs';
import { containsTime,normalizeWindows } from './vault-grants.mjs';
import crypto from 'node:crypto';
import { cleanupLegacy } from './vault-cleanup.mjs';
import { initializeArchives,attachArchiveViews,detachArchiveViews,deleteArchivedWindows,archiveCutoff } from './history-archive.mjs';
import { storageSnapshot,saveStoragePolicy,storagePolicy,archiveOldHistory,tidyBackupStaging } from './storage-manager.mjs';
import { compactHistory } from './storage-compaction.mjs';
import { DiagnosticHistory } from './ai-diagnostic-store.mjs';
import {importBudgetMs,measureImportProgress} from './import-progress.mjs';

const {dataRoot,metadata,secrets}=workerData,stores=new Map();
const entries=vaultKeyEntries(dataRoot,secrets);
let compacting=false,storageTask=null,stopArchive=false,storageJob=null,lastSnapshot=null;
let diagnostics;
function diagnosticStore(){return diagnostics??=new DiagnosticHistory(dataRoot,metadata,secrets);}
const importLanes=['windows','clash','diagnostics'],importStates=new Map(importLanes.map(lane=>[lane,{pending:true,retryAt:0,remaining:null,processed:0,error:null,samples:[]}]));
// At most three source handles per unlocked writer. Reopening and closing on
// every slice can repeatedly checkpoint an otherwise idle source queue.
const importConnections=new Map();
function importConnection(lane){
  if(!importConnections.has(lane)){
    const file=path.join(dataRoot,lane,'ingest.sqlite');
    if(fs.existsSync(file))importConnections.set(lane,new PlainDatabase(file));
  }
  return importConnections.get(lane);
}
let importTimer,importIndex=0,lastImportStatus='',lastImportReport=0,initialArchivePending=true,importStarted=performance.now();
const importError=error=>['SQLITE_BUSY','SQLITE_LOCKED'].includes(error.code)?'database_busy':/^(ingest_|invalid_(?:encrypted_packet|packet_signature|ingest_|diagnostic_))/.test(error.message)?'packet_validation_failed':'import_failed';
function recordImportSample(state,now){
  if(state.remaining===null)return;
  const previous=state.samples.at(-1);if(previous&&now-previous.at<500)return;
  state.samples.push({at:now,remaining:state.remaining,processed:state.processed});
  while(state.samples.length>64||state.samples.length>2&&now-state.samples[0].at>30000)state.samples.shift();
}
function importTick(){
  if(compacting||storageTask){importTimer=setTimeout(importTick,500);return;}
  const lane=importLanes[importIndex++%importLanes.length],state=importStates.get(lane);
  if(Date.now()>=state.retryAt){
    try{
      const options={limit:128,maxMs:importBudgetMs(state.remaining),includeRemaining:true,connection:importConnection(lane)};
      const batch=lane==='diagnostics'?diagnosticStore().drainBatch(options):drainIngestBatch(stores.get(lane),metadata,secrets,options);
      state.pending=batch.pending;state.remaining=batch.remaining;state.processed+=batch.count;state.retryAt=0;state.error=null;
      if(batch.count&&lane!=='diagnostics')stores.get(lane).checkBudgets();
    }catch(error){
      state.pending=true;state.retryAt=Date.now()+60000;state.error=importError(error);state.processed+=error.importedCount||0;if(Number.isSafeInteger(error.remaining))state.remaining=error.remaining;
    }
    recordImportSample(state,performance.now());
  }
  const failed=importLanes.find(name=>importStates.get(name).retryAt>Date.now()),pending=importLanes.find(name=>importStates.get(name).pending&&!importStates.get(name).retryAt);
  const status={state:failed?'paused':pending?'running':'complete',lane:failed||pending||null};
  const signature=JSON.stringify(status),now=performance.now();
  if(signature!==lastImportStatus||now-lastImportReport>=1000){
    const lanes=Object.fromEntries(importLanes.map(name=>{const value=importStates.get(name),rate=measureImportProgress(value.samples,now,value.remaining);return [name,{remaining:value.remaining,processed:value.processed,error:value.error,...rate}];}));
    const processed=importLanes.reduce((sum,name)=>sum+importStates.get(name).processed,0),remaining=importLanes.every(name=>importStates.get(name).remaining!==null)?importLanes.reduce((sum,name)=>sum+importStates.get(name).remaining,0):null;
    const measured=Object.values(lanes).filter(value=>Number.isFinite(value.importedPerSecond)),packetsPerSecond=measured.length?Number(measured.reduce((sum,value)=>sum+value.importedPerSecond,0).toFixed(1)):null,arrivingPerSecond=measured.length?Number(measured.reduce((sum,value)=>sum+value.arrivingPerSecond,0).toFixed(1)):null,netPerSecond=measured.length?Number(measured.reduce((sum,value)=>sum+value.netPerSecond,0).toFixed(1)):null,etaSeconds=remaining>0&&netPerSecond>0?Math.ceil(remaining/netPerSecond):null;
    parentPort.postMessage({event:'import-progress',...status,lanes,processed,remaining,packetsPerSecond,arrivingPerSecond,netPerSecond,etaSeconds,measurementSeconds:measured.length?Math.min(30,...measured.map(value=>value.measurementSeconds)):0,stalled:measured.some(value=>value.stalled),averagePacketsPerSecond:Math.round(processed/Math.max(1,(now-importStarted)/1000)),updatedAt:Date.now()});lastImportStatus=signature;lastImportReport=now;
  }
  if(status.state==='complete'&&initialArchivePending){initialArchivePending=false;setImmediate(()=>runArchive({automatic:true}).catch(()=>{}));}
  importTimer=setTimeout(importTick,pending?10:500);
}
const emitStorage=value=>{
  storageJob={...storageJob,...value,updatedAt:Date.now()};
  parentPort.postMessage({event:'storage-progress',...storageJob});
};
async function openStore(lane) {
  parentPort.postMessage({event:'progress',phase:'opening',lane});
  const key=entries.find(([filename])=>filename.includes(`${path.sep}${lane}${path.sep}`))[1];
  const store=await migrateLane(dataRoot,lane,key,{progress:value=>parentPort.postMessage({event:'progress',phase:'migration',...value})});
  store.vaultLane=lane;store.vaultDir=path.join(dataRoot,lane);initializeImport(store);initializeArchives(store);
  store.db.exec(`CREATE TABLE IF NOT EXISTS vault_notes(id TEXT PRIMARY KEY,lane TEXT NOT NULL,at INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vault_deletions(start_at INTEGER NOT NULL,end_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vault_audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);`);
  stores.set(lane,store);return store;
}
function runArchive({automatic=false}={}) {
  if(storageTask)return storageTask;
  if(compacting)return Promise.reject(new Error('vault_storage_busy'));
  if(automatic&&(importLanes.some(lane=>importStates.get(lane).pending)||![...stores.values()].some(store=>{
    const policy=storagePolicy(store);if(!policy.enabled)return false;
    const cutoff=archiveCutoff(Date.now(),policy.onlineDays);
    return Boolean(store.db.prepare('SELECT 1 FROM samples WHERE at<? LIMIT 1').get(cutoff)||store.db.prepare('SELECT 1 FROM buckets WHERE minute<? LIMIT 1').get(cutoff));
  })))return Promise.resolve({moved:0,rawBytes:0,compressedBytes:0});
  stopArchive=false;storageJob={state:'running',operation:'archive',stage:'preparing',startedAt:Date.now()};emitStorage({});
  storageTask=archiveOldHistory(stores,{progress:emitStorage,shouldStop:()=>stopArchive}).then(result=>{
    tidyBackupStaging(dataRoot);emitStorage({state:result.paused?'paused':'completed',stage:'complete',result});
    lastSnapshot=storageSnapshot(dataRoot,stores,storageJob);return result;
  }).catch(error=>{emitStorage({state:'failed',error:error.message});throw error;}).finally(()=>{storageTask=null;});
  return storageTask;
}
try {
  for(const lane of ['windows','clash'])await openStore(lane);
  // Existing history is queryable as soon as its databases are open. Never
  // make an unlock wait for a queue that active collectors keep appending to.
  parentPort.postMessage({event:'ready',backgroundImport:{state:'running',lane:'windows'}});
  importStarted=performance.now();
  const autoStart=setTimeout(()=>runArchive({automatic:true}).catch(()=>{}),15000);
  const maintenanceTimer=setInterval(()=>{if(!compacting)runArchive({automatic:true}).catch(()=>{});},6*3600000);
  importTimer=setTimeout(importTick,25);
  parentPort.on('message',async({id,action,lane,windows,...request})=>{
    try{
      if(action==='diagnostic-query'){
        const history=diagnosticStore();const result=history.query({...request,windows});
        parentPort.postMessage({id,result});return;
      }
      if(action==='diagnostic-attachment'){
        const result=diagnosticStore().attachment(request.attachmentId,normalizeWindows(windows));parentPort.postMessage({id,result});return;
      }
      if(action==='diagnostic-delete-attachment'){
        const result=diagnosticStore().deleteAttachment(request.attachmentId,normalizeWindows(windows));parentPort.postMessage({id,result});return;
      }
      if(lane==='diagnostics'&&['notes','create','update','delete-note'].includes(action)){
        const result=diagnosticStore().notes(action,normalizeWindows(windows),request.note);
        parentPort.postMessage({id,result});return;
      }
      if(compacting&&action!=='storage-status')throw new Error('vault_storage_busy');
      const store=stores.get(lane||'windows');if(!store)throw new Error('invalid_lane');
      let result;
      if(action==='storage-status'){
        if(!compacting&&(!lastSnapshot||Date.now()-lastSnapshot.generatedAt>=60000||request.fresh))lastSnapshot=storageSnapshot(dataRoot,stores,storageJob);
        result={...lastSnapshot,job:storageJob};
      }else if(action==='storage-policy'){
        result={policy:saveStoragePolicy(stores,request.policy)};
        if(!request.policy.enabled)stopArchive=true;lastSnapshot=null;
      }else if(action==='storage-run'){
        result=await runArchive();
      }else if(action==='storage-compact'){
        lastSnapshot=storageSnapshot(dataRoot,stores,storageJob);compacting=true;stopArchive=true;
        try{
          await storageTask?.catch(()=>{});
          storageJob={state:'running',operation:'compact',stage:'preparing',startedAt:Date.now()};emitStorage({});
          result={lanes:[]};
          for(const [name,current] of [...stores]){
            const file=path.join(dataRoot,name,'history.vault.sqlite'),key=entries.find(([filename])=>filename===file)[1];
            try{
              const value=await compactHistory(current,file,key,{progress:progress=>emitStorage({...progress,lane:name})});
              result.lanes.push({lane:name,...value});
            }finally{
              // A failed rename may have closed the source. Startup recovery and
              // keyed validation choose the committed copy before importing.
              if(!current.db.open)await openStore(name);
            }
          }
          emitStorage({state:'completed',stage:'complete',result});
        }catch(error){emitStorage({state:'failed',error:error.message});throw error;}
        finally{compacting=false;}
      }else if(action==='cleanup'){
        result=cleanupLegacy({dataRoot,stores,entries,progress:value=>parentPort.postMessage({event:'cleanup-progress',...value})});
      }else if(action==='audit'){
        store.db.prepare('INSERT INTO vault_audit(at,actor,action,detail) VALUES (?,?,?,?)').run(Date.now(),String(request.actor).slice(0,80),String(request.operation).slice(0,80),JSON.stringify(request.detail??{}));result={ok:true};
      }else if(action==='notes'){
        const periods=normalizeWindows(windows),predicate=periods.map(()=>'(at>=? AND at<?)').join(' OR '),params=periods.flatMap(window=>[window.from,window.to]);
        result=store.db.prepare(`SELECT * FROM vault_notes WHERE ${predicate} ORDER BY at DESC LIMIT 500`).all(...params);
      }else if(['create','update','delete-note'].includes(action)){
        const periods=normalizeWindows(windows),note=request.note||{};
        const existing=note.id&&store.db.prepare('SELECT * FROM vault_notes WHERE id=?').get(note.id);
        if(action!=='create'&&(!existing||!containsTime(periods,existing.at)))throw new Error('grant_date_forbidden');
        if(action==='delete-note')store.db.prepare('DELETE FROM vault_notes WHERE id=?').run(note.id);
        else{
          if(!Number.isSafeInteger(note.at)||!containsTime(periods,note.at))throw new Error('grant_date_forbidden');
          if(typeof note.title!=='string'||note.title.length>200||typeof note.body!=='string'||note.body.length>8000)throw new Error('invalid_note');
          const noteId=action==='create'?crypto.randomUUID():note.id;
          store.db.prepare(`INSERT INTO vault_notes VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,title=excluded.title,body=excluded.body,updated_at=excluded.updated_at`).run(noteId,lane,note.at,note.title,note.body,Date.now(),Date.now());result={id:noteId};
        }
        result??={ok:true};
      }else if(action==='delete-history'){
        const periods=normalizeWindows(windows),params=periods.flatMap(window=>[window.from,window.to]);
        const predicate=column=>periods.map(()=>`(${column}>=? AND ${column}<?)`).join(' OR ');
        store.db.exec('BEGIN IMMEDIATE');
        try{
          for(const period of periods)store.db.prepare('INSERT INTO vault_deletions VALUES (?,?)').run(period.from,period.to);
          deleteArchivedWindows(store.db,periods);
          for(const [table,column] of [['samples','at'],['buckets','minute'],['alerts','at'],['sessions','activity'],['vault_notes','at']])store.db.prepare(`DELETE FROM ${table} WHERE ${predicate(column)}`).run(...params);
          store.db.prepare(`DELETE FROM anomalies WHERE ${predicate('ended_at')}`).run(...params);
          const gaps=store.db.prepare('SELECT * FROM collection_gaps').all();
          for(const gap of gaps){
            let segments=[{from:gap.started_at,to:gap.ended_at??Number.MAX_SAFE_INTEGER}];
            for(const period of periods)segments=segments.flatMap(segment=>segment.to<=period.from||segment.from>=period.to?[segment]:[
              ...(segment.from<period.from?[{from:segment.from,to:period.from}]:[]),...(segment.to>period.to?[{from:period.to,to:segment.to}]:[])]);
            store.db.prepare('DELETE FROM collection_gaps WHERE id=?').run(gap.id);
            for(const segment of segments)store.db.prepare('INSERT INTO collection_gaps(reason,started_at,ended_at) VALUES (?,?,?)').run(gap.reason,segment.from,segment.to===Number.MAX_SAFE_INTEGER?null:segment.to);
          }
          attachArchiveViews(store.db,{windows:[{from:0,to:Number.MAX_SAFE_INTEGER}]});
          store.db.exec(`DELETE FROM connections WHERE NOT EXISTS(SELECT 1 FROM temp.tw_all_buckets WHERE connection_id=connections.id);
            UPDATE connections SET first_seen=(SELECT MIN(minute) FROM temp.tw_all_buckets WHERE connection_id=connections.id),last_seen=(SELECT MAX(last_at) FROM temp.tw_all_buckets WHERE connection_id=connections.id);
            DELETE FROM daily_usage;DELETE FROM budget_notifications;`);
          // Keep the user's budget time zone, including its DST boundaries.
          const days=new Map();
          for(const row of store.db.prepare('SELECT * FROM temp.tw_all_samples').iterate()){
            const day=store.calendar.day(row.at),total=days.get(day)||{codex_up:0,codex_down:0,all_up:0,all_down:0,first_at:row.at,last_at:row.at};
            for(const key of ['codex_up','codex_down','all_up','all_down'])total[key]+=row[key];
            total.first_at=Math.min(total.first_at,row.at);total.last_at=Math.max(total.last_at,row.at);days.set(day,total);
          }
          for(const [day,row] of days)store.insertDaily.run(day,row.codex_up,row.codex_down,row.all_up,row.all_down,row.first_at,row.last_at);
          detachArchiveViews(store.db);
          store.set('vaultDataRevision',store.get('vaultDataRevision',0)+1);
          store.db.exec('COMMIT');result={ok:true,deletedWindows:periods};
        }catch(error){store.db.exec('ROLLBACK');detachArchiveViews(store.db);throw error;}
      }else if(action==='audit-list')result=store.db.prepare('SELECT * FROM vault_audit ORDER BY id DESC LIMIT 200').all();
      else throw new Error('invalid_vault_operation');
      parentPort.postMessage({id,result});
    }catch(error){parentPort.postMessage({id,error:error.message});}
  });
  parentPort.on('close',()=>{clearTimeout(importTimer);clearInterval(maintenanceTimer);clearTimeout(autoStart);for(const source of importConnections.values())source.close();diagnostics?.close();for(const store of stores.values())store.close();for(const [,key] of entries)key.fill(0);});
}catch(error){parentPort.postMessage({event:'failed',error:error.message});process.exitCode=1;}

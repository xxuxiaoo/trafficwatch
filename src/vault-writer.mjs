import path from 'node:path';
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

const {dataRoot,metadata,secrets}=workerData,stores=new Map();
const entries=vaultKeyEntries(dataRoot,secrets);
let compacting=false,storageTask=null,stopArchive=false,storageJob=null,lastSnapshot=null;
let diagnostics;
function diagnosticStore(){return diagnostics??=new DiagnosticHistory(dataRoot,metadata,secrets);}
const importLanes=['windows','clash','diagnostics'],importStates=new Map(importLanes.map(lane=>[lane,{pending:true,retryAt:0}]));
let importTimer,importIndex=0,lastImportStatus='',initialArchivePending=true;
function importTick(){
  if(compacting||storageTask){importTimer=setTimeout(importTick,500);return;}
  const lane=importLanes[importIndex++%importLanes.length],state=importStates.get(lane);
  if(Date.now()>=state.retryAt){
    try{
      const batch=lane==='diagnostics'?diagnosticStore().drainBatch({limit:16,maxMs:40}):drainIngestBatch(stores.get(lane),metadata,secrets,{limit:16,maxMs:40});
      state.pending=batch.pending;state.retryAt=0;
      if(batch.count&&lane!=='diagnostics')stores.get(lane).checkBudgets();
    }catch{
      state.pending=true;state.retryAt=Date.now()+60000;
    }
  }
  const failed=importLanes.find(name=>importStates.get(name).retryAt>Date.now()),pending=importLanes.find(name=>importStates.get(name).pending&&!importStates.get(name).retryAt);
  const status={state:failed?'paused':pending?'running':'complete',lane:failed||pending||null};
  const signature=JSON.stringify(status);
  if(signature!==lastImportStatus){parentPort.postMessage({event:'import-progress',...status});lastImportStatus=signature;}
  if(status.state==='complete'&&initialArchivePending){initialArchivePending=false;setImmediate(()=>runArchive({automatic:true}).catch(()=>{}));}
  importTimer=setTimeout(importTick,pending?50:500);
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
  parentPort.on('close',()=>{clearTimeout(importTimer);clearInterval(maintenanceTimer);clearTimeout(autoStart);diagnostics?.close();for(const store of stores.values())store.close();for(const [,key] of entries)key.fill(0);});
}catch(error){parentPort.postMessage({event:'failed',error:error.message});process.exitCode=1;}

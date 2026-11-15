import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {eventId} from './ai-diagnostic-events.mjs';
import {IncrementalTail} from './ai-log-tail.mjs';
import {IncrementalZstdTail} from './ai-zstd-tail.mjs';
import {normalizeCcSwitchRequest,normalizeCodexLog,normalizeCodexText,normalizeClaudeRecord,normalizeClaudeDebug,normalizeDshRecord} from './ai-log-adapters.mjs';

const sinceDay=now=>Date.parse(new Date(now+8*3600000-86400000).toISOString().slice(0,10)+'T00:00:00+08:00');
const identityOf=stat=>String(stat.ino)+':'+String(stat.birthtimeMs);

// Discovery is bounded and infrequent; symbolic links are never traversed.
async function discover(root,depth,pattern,{budget=4096}={}){
  const files=[],queue=[{dir:root,depth}],result={files,limited:false,exists:false,readError:false};
  let visited=0;
  while(queue.length){
    const item=queue.shift();let entries;
    try{entries=await fs.promises.readdir(item.dir,{withFileTypes:true});result.exists=true;}
    catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))result.readError=true;continue;}
    for(const entry of entries){
      if(++visited>budget){result.limited=true;return result;}
      if(entry.isSymbolicLink())continue;const file=path.join(item.dir,entry.name);
      if(entry.isDirectory()&&item.depth>0)queue.push({dir:file,depth:item.depth-1});
      else if(entry.isFile()&&pattern.test(entry.name))try{const stat=await fs.promises.stat(file);files.push({file,mtime:stat.mtimeMs});}catch{result.readError=true;}
    }
  }
  files.sort((a,b)=>b.mtime-a.mtime);return result;
}

export class DiagnosticLogSources {
  constructor({ownerProfile,onEvent,onGap=()=>{},checkpoints={},now=Date.now,maxFiles=16,pollFiles=8}={}){
    Object.assign(this,{ownerProfile,onEvent,onGap,checkpoints,now,maxFiles,pollFiles});
    this.tails=new Map();this.sources=new Map();this.databases=new Map();this.lastDiscovery=0;this.round=0;
    for(const id of ['cc-switch','codex','claude','dsh'])this.sources.set(id,{id,state:'starting',capability:id==='cc-switch'?'request_summary':'errors_and_retries',lastPollAt:null,lastEventAt:null,parseFailures:0,timeFailures:0,gaps:0,events:0,files:0,bytesBehind:0});
  }
  emit(source,event){if(!event)return;const state=this.sources.get(source);state.events++;state.lastEventAt=Math.max(state.lastEventAt||0,event.at);this.onEvent(event);}
  gap(source,reason){this.sources.get(source).gaps++;this.onGap(reason,source);}
  addTail(source,file,parser){
    const key=eventId('log-source',file);if(this.tails.has(key))return key;
    const onLine=(line,context)=>{
      let raw=line;if(file.endsWith('.jsonl')||file.endsWith('.zstd')){
        if(!line.trim())return;try{raw=JSON.parse(line);}catch{this.sources.get(source).parseFailures++;return;}
      }
      const event=parser(raw,{...context,sourceKey:key,observedAt:this.now(),onInvalidTime:()=>{this.sources.get(source).timeFailures++;}});this.emit(source,event);
    };
    const options={...this.checkpoints[key],maxRead:256*1024,onLine,onGap:reason=>this.gap(source,reason)};
    const tail=file.endsWith('.zstd')?new IncrementalZstdTail(file,options):new IncrementalTail(file,options);
    this.tails.set(key,{source,tail});return key;
  }
  async discover(){
    this.lastDiscovery=this.now();const home=this.ownerProfile;
    const specs=[
      ['claude',path.join(home,'.claude','projects'),2,/\.jsonl$/,normalizeClaudeRecord],
      ['claude',path.join(home,'.claude','debug'),0,/\.(?:txt|log)$/,normalizeClaudeDebug],
      ['dsh',path.join(home,'.dsh','sessions'),2,/^session(?:\.v[234])?\.jsonl(?:\.zstd)?$/,normalizeDshRecord],
      ['codex',path.join(home,'.codex','log'),0,/^codex-tui\.log(?:\.\d+)?$/,normalizeCodexText],
    ];
    const keep=new Set();for(const source of this.sources.values()){source.discovered=0;source.discoveryLimited=false;source.discoveryError=false;}
    for(const [source,root,depth,pattern,parser]of specs){
      const found=await discover(root,depth,pattern),state=this.sources.get(source);
      state.discovered+=found.files.length;state.discoveryLimited||=found.limited;state.discoveryError||=found.readError;
      const eligible=found.files.filter(item=>item.mtime>=sinceDay(this.now()));
      if(eligible.length>this.maxFiles)state.discoveryLimited=true;
      for(const {file}of eligible.slice(0,this.maxFiles))keep.add(this.addTail(source,file,parser));
    }
    for(const [key,{tail}]of this.tails)if(!keep.has(key)){tail.close?.();this.tails.delete(key);}
  }
  async database(source,file){
    const state=this.sources.get(source);let stat;
    try{stat=await fs.promises.stat(file);}catch(error){state.databaseState=['ENOENT','ENOTDIR'].includes(error.code)?'missing':'read_error';return;}
    state.modifiedAt=stat.mtimeMs;const key=eventId('db-source',file),identity=identityOf(stat),saved=this.checkpoints[key];
    let session=this.databases.get(source);
    if(session?.identity!==identity){
      session?.db.close();session=null;this.databases.delete(source);
    }
    try{
      if(!session){
        const db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA busy_timeout=30;PRAGMA query_only=ON');
        try{
          const table=source==='cc-switch'?'proxy_request_logs':'logs',cols=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(row=>row.name));
          const required=source==='cc-switch'?['request_id','provider_id','app_type','created_at','status_code','data_source']:['id','ts','target','feedback_log_body'];
          if(required.some(col=>!cols.has(col))){db.close();state.databaseState='unsupported_schema';return;}
          const maximum=db.prepare(source==='cc-switch'?'SELECT COALESCE(MAX(rowid),0) n FROM proxy_request_logs':'SELECT COALESCE(MAX(id),0) n FROM logs').get().n;
          const start=saved?.identity===identity?saved.last:Math.max(0,(db.prepare(source==='cc-switch'?"SELECT MIN(rowid) n FROM proxy_request_logs WHERE created_at>=? AND data_source='proxy'":'SELECT MIN(id) n FROM logs WHERE ts>=?').get(sinceDay(this.now())/1000).n??maximum+1)-1);
          const providers=source==='cc-switch'&&Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='providers'").get());
          session={db,identity,cols,last:start,initial:maximum,providers};this.databases.set(source,session);
        }catch(error){db.close();throw error;}
      }
      const {db,cols}=session,cc=source==='cc-switch';
      const maximum=db.prepare(cc?'SELECT COALESCE(MAX(rowid),0) n FROM proxy_request_logs':'SELECT COALESCE(MAX(id),0) n FROM logs').get().n;
      if(maximum<session.last){session.last=0;session.initial=maximum;this.gap(source,'source_database_reset');}
      const limit=256;
      const select=cc?['request_id','provider_id','app_type','created_at','status_code','data_source','error_message','latency_ms','first_token_ms','duration_ms'].filter(col=>cols.has(col)).join(',')+(session.providers?',(SELECT name FROM providers WHERE id=proxy_request_logs.provider_id AND app_type=proxy_request_logs.app_type LIMIT 1) provider_name':''):'id,ts,target,feedback_log_body'+(cols.has('level')?',level':",'' level")+(cols.has('ts_nanos')?',ts_nanos':'');
      const rows=db.prepare(cc?`SELECT rowid sourceRow,${select} FROM proxy_request_logs WHERE rowid>? AND rowid<=? AND data_source='proxy' ORDER BY rowid LIMIT ?`:
        `SELECT ${select} FROM logs WHERE id>? AND id<=? AND (target LIKE 'codex_http_client::%' OR target LIKE 'codex_api::%' OR target IN ('codex_core::stream_events_utils','codex_core::client','codex_core::client_common')) ORDER BY id LIMIT ?`).all(session.last,maximum,limit);
      for(const row of rows){const index=cc?row.sourceRow:row.id;this.emit(source,(cc?normalizeCcSwitchRequest:normalizeCodexLog)(row,{sourceKey:eventId(key,identity),historicalImport:index<=session.initial,observedAt:this.now(),onInvalidTime:()=>{state.timeFailures++;}}));}
      session.last=rows.length===limit?(cc?rows.at(-1).sourceRow:rows.at(-1).id):maximum;
      this.checkpoints[key]={identity,last:session.last};state.databaseState=rows.length===limit?'backlog':'caught_up';state.databaseRowsBehind=maximum-session.last;
    }catch(error){state.databaseState=/SQLITE_(?:BUSY|LOCKED)/.test(error.code||'')?'busy':'read_error';}
  }
  async poll(){
    if(!this.lastDiscovery||this.now()-this.lastDiscovery>=60000)await this.discover();
    await this.database('cc-switch',path.join(this.ownerProfile,'.cc-switch','cc-switch.db'));
    let codexDb;
    try{codexDb=(await fs.promises.readdir(path.join(this.ownerProfile,'.codex'))).filter(name=>/^logs_\d+\.sqlite$/.test(name)).sort((a,b)=>Number(b.match(/\d+/)[0])-Number(a.match(/\d+/)[0]))[0];}catch{}
    if(codexDb)await this.database('codex',path.join(this.ownerProfile,'.codex',codexDb));else this.sources.get('codex').databaseState='missing';
    const tails=[...this.tails.entries()];
    for(let i=0;i<Math.min(this.pollFiles,tails.length);i++){
      const [key,{source,tail}]=tails[(this.round+i)%tails.length];
      try{await tail.poll();this.checkpoints[key]=tail.checkpoint();}catch{tail.status.state='read_error';this.gap(source,'adapter_log_read_failed');}
    }
    if(tails.length)this.round=(this.round+this.pollFiles)%tails.length;
    for(const state of this.sources.values()){
      const active=tails.filter(([,entry])=>entry.source===state.id).map(([,entry])=>entry.tail.status);
      state.lastPollAt=this.now();state.files=active.length;state.bytesBehind=active.reduce((sum,item)=>sum+(item.bytesBehind||0),0);
      const states=active.map(item=>item.state);if(state.databaseState)states.push(state.databaseState);
      state.state=state.discoveryError||states.includes('read_error')?'read_error':states.includes('unsupported_schema')?'unsupported_schema':states.includes('busy')?'busy':state.discoveryLimited?'limited':states.includes('backlog')?'backlog':states.some(s=>s==='caught_up')?'caught_up':state.discovered?'quiet':'missing';
    }
  }
  snapshot(){return [...this.sources.values()].map(state=>({...state}));}
  resetCounters(){for(const state of this.sources.values())for(const key of ['parseFailures','timeFailures','gaps','events'])state[key]=0;}
  checkpoint(){
    const result={...this.checkpoints};
    // Keep only bounded cursor metadata, including sources temporarily absent.
    const entries=Object.entries(result);return Object.fromEntries(entries.slice(-512));
  }
  close(){for(const {tail}of this.tails.values())tail.close?.();for(const {db}of this.databases.values())db.close();}
}

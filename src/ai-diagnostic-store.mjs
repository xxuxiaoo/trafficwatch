import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {DatabaseSync as PlainDatabase} from 'node:sqlite';
import {DatabaseSync} from './database.mjs';
import {dpapi} from './vault-platform.mjs';
import {sealPacket,openPacket,packetFormat,purposeKey} from './vault-crypto.mjs';
import {containsTime,containsInterval,intersectWindows} from './vault-grants.mjs';
import {diagnosticTriggers} from './ai-diagnostic-events.mjs';
import {DiagnosticFilters} from './ai-diagnostic-filters.mjs';
import {drainSealedQueue} from './sealed-queue.mjs';
import {correctTcpCategory} from './ai-tcp-events.mjs';

function correctProbeCompatibility(event){
  if(event.kind==='tcp')return correctTcpCategory(event);
  if(event.kind==='log'&&!event.timeSource)return {...event,timeSource:'unknown',observedAt:event.at,fault:false,legacyTimeUncertain:true};
  if(event.kind==='probe'&&event.errorType==='ArgumentException')return {...event,originalCategory:event.category,category:'probe_error',fault:false,collectorIssue:'framework_tls_probe_compatibility'};
  if(event.kind==='incident'&&event.evidence){
    const evidence=event.evidence.map(correctProbeCompatibility),triggers=[...new Set(evidence.flatMap(diagnosticTriggers))];
    return {...event,evidence,triggers:triggers.length?triggers:['evidence_uncertain'],collectorTestArtifact:!triggers.length,...(!event.schemaVersion?{legacyEvidence:true}:{})};
  }
  if(event.kind==='incident'&&!event.schemaVersion)return {...event,legacyEvidence:true};
  return event;
}

export class DiagnosticSpool {
  constructor(dataRoot,metadata,{signingKey}={}){
    this.metadata=metadata;this.signingKey=signingKey??dpapi(fs.readFileSync(path.join(dataRoot,'vault','capture-signing.dpapi')),{scope:'machine',decrypt:true});
    fs.mkdirSync(path.join(dataRoot,'diagnostics'),{recursive:true});
    this.db=new PlainDatabase(path.join(dataRoot,'diagnostics','ingest.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=2000;CREATE TABLE IF NOT EXISTS envelopes(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,payload BLOB NOT NULL)');
    this.insert=this.db.prepare('INSERT INTO envelopes(id,payload) VALUES (?,?)');
  }
  append(events){
    if(!events.length)return;const id=crypto.randomUUID();
    const packet=sealPacket(events,this.metadata.publicKey,{format:packetFormat,vault:this.metadata.id,lane:'diagnostics',id},this.signingKey);
    this.insert.run(id,Buffer.from(JSON.stringify(packet)));
  }
  close(){this.db.close();if(Buffer.isBuffer(this.signingKey))this.signingKey.fill(0);}
}

export class DiagnosticHistory {
  constructor(dataRoot,metadata,secrets){
    this.dataRoot=dataRoot;this.metadata=metadata;this.secrets=secrets;
    const dir=path.join(dataRoot,'diagnostics');fs.mkdirSync(dir,{recursive:true});
    const master=Buffer.from(secrets.master,'base64'),key=purposeKey(master,'database/diagnostics');master.fill(0);
    try{this.db=new DatabaseSync(path.join(dir,'history.vault.sqlite'),{encryptionKey:key});}finally{key.fill(0);}
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,provider TEXT NOT NULL,harness TEXT NOT NULL,gateway TEXT NOT NULL,category TEXT NOT NULL,payload BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS events_time ON events(at DESC,id);
      CREATE INDEX IF NOT EXISTS events_kind_time ON events(kind,at DESC);
      CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS superseded_events(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS request_quality(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,request_at INTEGER,request_end INTEGER,expected INTEGER,attempt INTEGER,phase TEXT NOT NULL,system TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS diagnostic_notes(id TEXT PRIMARY KEY,at INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(events)').all().some(column=>column.name==='end_at'))this.db.exec('ALTER TABLE events ADD COLUMN end_at INTEGER');
    if(!this.db.prepare('PRAGMA table_info(events)').all().some(column=>column.name==='preview'))this.db.exec('ALTER TABLE events ADD COLUMN preview BLOB');
    if(!this.db.prepare('PRAGMA table_info(events)').all().some(column=>column.name==='schema_version'))this.db.exec('ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1');
    if(!this.db.prepare('PRAGMA table_info(events)').all().some(column=>column.name==='time_source')){
      this.db.exec("ALTER TABLE events ADD COLUMN time_source TEXT NOT NULL DEFAULT 'recorded';UPDATE events SET time_source='unknown' WHERE kind='log'");
    }
    this.filters=new DiagnosticFilters(this.db);
  }
  drainBatch({limit=32,...options}={}){
    return drainSealedQueue(path.join(this.dataRoot,'diagnostics','ingest.sqlite'),this.db,row=>{
        const digest=crypto.createHash('sha256').update(row.payload).digest('hex'),previous=this.db.prepare('SELECT digest FROM imports WHERE id=?').get(row.id);
        if(previous&&previous.digest!==digest)throw new Error('ingest_id_conflict');
        if(!previous){
          const packet=JSON.parse(Buffer.from(row.payload).toString('utf8'));
          if(packet.header?.id!==row.id||packet.header?.vault!==this.metadata.id||packet.header?.lane!=='diagnostics')throw new Error('ingest_header_mismatch');
          const events=openPacket(packet,this.secrets.privateKey,this.metadata.capturePublicKey);
          if(!Array.isArray(events)||events.length>1024)throw new Error('invalid_diagnostic_batch');
          this.db.exec('SAVEPOINT diagnostic_import_envelope');
          try{for(const event of events)this.put(event);this.db.prepare('INSERT INTO imports VALUES (?,?)').run(row.id,digest);this.db.exec('RELEASE diagnostic_import_envelope');}
          catch(error){this.db.exec('ROLLBACK TO diagnostic_import_envelope;RELEASE diagnostic_import_envelope');throw error;}
        }
    },{limit,...options});
  }
  drain(limit=32){return this.drainBatch({limit}).count;}
  put(event){
    event=correctProbeCompatibility(event);
    if(typeof event.id!=='string'||event.id.length>128||!Number.isSafeInteger(event.at)||!['request','incident','probe','gap','status','mark','route','resource','tcp','log'].includes(event.kind))throw new Error('invalid_diagnostic_event');
    const payload=Buffer.from(JSON.stringify(event));if(payload.length>24*1024*1024)throw new Error('diagnostic_event_too_large');
    if(this.db.prepare('SELECT 1 FROM superseded_events WHERE id=?').get(event.id))return;
    if(event.kind==='log'&&event.timeSource==='unknown'&&this.db.prepare("SELECT 1 FROM events WHERE id=? AND kind='log' AND time_source!='unknown'").get(event.id))return;
    if(event.kind==='request'&&event.gateway==='magpie'&&event.schemaVersion===2&&/^[a-f0-9]{32}$/.test(event.legacyId)&&event.legacyId!==event.id){
      // Signed, corrected source replay replaces the collided legacy entry.
      // A tombstone prevents a delayed old queue from recreating a duplicate.
      const legacy=this.db.prepare('SELECT payload FROM events WHERE id=? AND kind=\'request\' AND gateway=\'magpie\' AND schema_version<2').get(event.legacyId);
      if(legacy){
        const previous=JSON.parse(inflateRawSync(legacy.payload,{maxOutputLength:32*1024*1024}));
        if(previous.requestId!==event.requestId)throw new Error('invalid_diagnostic_replacement');
        this.db.prepare('DELETE FROM events WHERE id=?').run(event.legacyId);
        this.db.prepare('DELETE FROM diagnostic_filter_entries WHERE event_id=?').run(event.legacyId);
        this.db.prepare('DELETE FROM diagnostic_filter_indexed WHERE id=?').run(event.legacyId);
      }
      this.db.prepare('INSERT OR IGNORE INTO superseded_events VALUES (?)').run(event.legacyId);
    }
    const preview=event.kind==='incident'?{...event,evidence:undefined,evidenceCount:event.evidence.length}:event;
    this.db.prepare(`INSERT INTO events(id,at,kind,provider,harness,gateway,category,payload,end_at,preview,schema_version,time_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,kind=excluded.kind,provider=excluded.provider,harness=excluded.harness,gateway=excluded.gateway,category=excluded.category,payload=excluded.payload,end_at=excluded.end_at,preview=excluded.preview,schema_version=excluded.schema_version,time_source=excluded.time_source`).run(event.id,event.at,event.kind,String(event.provider||''),String(event.harness||''),String(event.gateway||''),String(event.category||''),deflateRawSync(payload),Number.isSafeInteger(event.end)?event.end:null,deflateRawSync(Buffer.from(JSON.stringify(preview))),Number(event.schemaVersion)||1,event.timeSource||'recorded');
    if(event.kind==='request')this.db.prepare('INSERT OR REPLACE INTO request_quality VALUES (?,?,?,?,?,?,?,?)').run(event.id,String(event.requestId||event.id),Number.isSafeInteger(event.requestAt)?event.requestAt:null,Number.isSafeInteger(event.requestEnd)?event.requestEnd:null,Number.isSafeInteger(event.expectedAttempts)?event.expectedAttempts:null,Number.isSafeInteger(event.attempt)?event.attempt:null,event.coverage?.phase||'unknown',event.coverage?.system||'unknown');
    this.filters.index(event);
  }
  query({windows,from=0,to=Date.now()+1,kind='',provider='',harness='',gateway='',category='',cursor=null,limit=60,eventId=null,owner=false}={}){
    from=Number(from);to=Number(to);if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<=from)throw new Error('invalid_diagnostic_range');
    limit=Math.min(100,Math.max(1,Number(limit)||60));
    const periods=intersectWindows(windows,from,to);if(!periods.length)return {rows:[],summary:[],next:null};
    const clauses=['('+periods.map(()=>'(at>=? AND at<? AND (end_at IS NULL OR end_at<?))').join(' OR ')+')'],params=periods.flatMap(p=>[p.from,p.to,p.to]);
    // An observation timestamp cannot prove that an old log belongs to a
    // visitor's exact authorized dates. Owners may inspect it with a warning.
    if(!owner)clauses.push("NOT(kind='log' AND time_source='unknown')");
    const collectionOnly=kind==='status'&&category==='collection_health'&&limit===1;
    const filterIndexPending=collectionOnly?false:this.filters.backfill({correct:correctProbeCompatibility});
    const facets=collectionOnly||eventId?null:this.filters.facets(clauses.join(' AND '),params,periods,{owner});
    const requestClauses=[clauses[0]],requestParams=[...params];
    for(const [key,value]of Object.entries({provider,harness,gateway}))if(value){if(typeof value!=='string'||value.length>96)throw new Error('invalid_diagnostic_filter');requestClauses.push(key+'=?');requestParams.push(value);}
    const requestSummary=collectionOnly?[]:this.db.prepare(`SELECT kind,category,COUNT(*) count FROM events WHERE ${requestClauses.join(' AND ')} AND kind='request' GROUP BY kind,category`).all(...requestParams);
    const quality=collectionOnly?{}:this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind='request' AND schema_version<2 THEN 1 ELSE 0 END),0) legacyRequests${owner?",COALESCE(SUM(CASE WHEN kind='log' AND time_source='unknown' THEN 1 ELSE 0 END),0) unknownLogTimes":''} FROM events WHERE ${requestClauses.join(' AND ')}`).get(...requestParams);
    const qualityWhere=requestClauses.join(' AND '),requestQuality=collectionOnly?[]:this.db.prepare(`SELECT q.phase,q.system,COUNT(*) count FROM events e JOIN request_quality q ON q.id=e.id WHERE ${qualityWhere} AND kind='request' GROUP BY q.phase,q.system`).all(...requestParams);
    quality.requestsChecked=requestQuality.filter(row=>row.phase!=='unknown'||row.system!=='unknown').reduce((sum,row)=>sum+row.count,0);quality.requestsUnchecked=requestSummary.reduce((sum,row)=>sum+row.count,0)-quality.requestsChecked;quality.phaseMissing=0;quality.phaseNotExposed=0;quality.tcpUnmatched=0;quality.systemUnavailable=0;quality.beforeCollection=0;quality.targetUnknown=0;quality.missingRetryAttempts=0;quality.retryChainsWithGaps=0;
    for(const row of requestQuality){if(row.phase==='missing')quality.phaseMissing+=row.count;if(row.phase==='not_exposed')quality.phaseNotExposed+=row.count;if(row.system==='no_matching_tcp')quality.tcpUnmatched+=row.count;if(row.system==='collector_unavailable')quality.systemUnavailable+=row.count;if(row.system==='before_collection')quality.beforeCollection+=row.count;if(row.system==='target_unknown')quality.targetUnknown+=row.count;}
    const chains=collectionOnly?[]:this.db.prepare(`SELECT q.request_id,MIN(q.request_at) first,MAX(q.request_end) last,MAX(q.expected) expected,COUNT(DISTINCT q.attempt) actual FROM events e JOIN request_quality q ON q.id=e.id WHERE ${qualityWhere} AND kind='request' AND gateway='magpie' AND q.expected IS NOT NULL GROUP BY q.request_id HAVING MAX(q.expected)>COUNT(DISTINCT q.attempt)`).all(...requestParams);
    for(const chain of chains)if(Number.isSafeInteger(chain.first)&&Number.isSafeInteger(chain.last)&&containsInterval(periods,chain.first,chain.last+1)){quality.retryChainsWithGaps++;quality.missingRetryAttempts+=chain.expected-chain.actual;}
    if(kind){if(typeof kind!=='string'||kind.length>96)throw new Error('invalid_diagnostic_filter');clauses.push('kind=?');params.push(kind);}
    const predicate=this.filters.predicate({provider,harness,gateway,category},periods,{owner});if(predicate){clauses.push(predicate.sql);params.push(...predicate.params);}
    const where=clauses.join(' AND ');
    const summary=this.db.prepare(`SELECT kind,category,COUNT(*) count FROM events WHERE ${where} GROUP BY kind,category`).all(...params);
    if(eventId){if(typeof eventId!=='string'||eventId.length>128)throw new Error('invalid_diagnostic_event');clauses.push('id=?');params.push(eventId);limit=1;}
    if(cursor){if(!Array.isArray(cursor)||cursor.length!==2||!Number.isSafeInteger(cursor[0])||typeof cursor[1]!=='string')throw new Error('invalid_diagnostic_cursor');clauses.push('(at<? OR (at=? AND id<?))');params.push(cursor[0],cursor[0],cursor[1]);}
    const found=this.db.prepare(`SELECT id,at,kind FROM events WHERE ${clauses.join(' AND ')} ORDER BY at DESC,id DESC LIMIT ?`).all(...params,limit+1),more=found.length>limit;found.length=Math.min(found.length,limit);
    const rows=found.map(row=>{
      const content=this.db.prepare(`SELECT ${eventId?'payload':'COALESCE(preview,payload)'} AS payload FROM events WHERE id=?`).get(row.id);
      const value=correctProbeCompatibility(JSON.parse(inflateRawSync(content.payload,{maxOutputLength:32*1024*1024})));
      if(value.category==='collection_health'&&!owner)for(const source of value.sources||[]){
        for(const key of ['lastEventAt','modifiedAt','lastPollAt'])if(Number.isFinite(source[key])&&!containsTime(periods,Math.floor(source[key])))source[key]=null;
      }
      if(value.kind==='incident'){
        // Per-item filtering prevents a permitted incident from exposing evidence on excluded dates.
        if(eventId){
          value.evidence=value.evidence.filter(event=>(owner||event.timeSource!=='unknown')&&containsTime(periods,event.at)&&(!Number.isSafeInteger(event.end)||containsInterval(periods,event.at,event.end+1)));
          value.triggers=[...new Set(value.evidence.flatMap(diagnosticTriggers))];value.evidenceCount=value.evidence.length;
        }else{
          delete value.evidence;
          if(!owner&&!containsInterval(periods,value.from,value.to)){value.triggers=[];value.evidenceCount=null;}
          value.detailAvailable=true;
        }
        value.authorizedSegments=intersectWindows(periods,value.from,value.to);delete value.from;delete value.to;
      }
      return value;
    });
    return {rows,summary,requestSummary,quality,facets,filterIndexPending,next:more?[found.at(-1).at,found.at(-1).id]:null,generatedAt:Date.now(),windows:periods};
  }
  notes(action,windows,note={}){
    if(action==='notes'){
      const clauses=windows.map(()=>'(at>=? AND at<?)').join(' OR ');return this.db.prepare(`SELECT * FROM diagnostic_notes WHERE ${clauses} ORDER BY at DESC LIMIT 500`).all(...windows.flatMap(p=>[p.from,p.to]));
    }
    const existing=note.id&&this.db.prepare('SELECT * FROM diagnostic_notes WHERE id=?').get(note.id);
    if(action!=='create'&&(!existing||!containsTime(windows,existing.at)))throw new Error('grant_date_forbidden');
    if(action==='delete-note'){this.db.prepare('DELETE FROM diagnostic_notes WHERE id=?').run(note.id);return {ok:true};}
    if(!Number.isSafeInteger(note.at)||!containsTime(windows,note.at))throw new Error('grant_date_forbidden');
    if(typeof note.title!=='string'||note.title.length>200||typeof note.body!=='string'||note.body.length>8000)throw new Error('invalid_note');
    const id=action==='create'?crypto.randomUUID():note.id;this.db.prepare('INSERT OR REPLACE INTO diagnostic_notes VALUES (?,?,?,?)').run(id,note.at,note.title,note.body);return {id};
  }
  attachment(id,windows){
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new Error('invalid_attachment');
    const file=path.join(this.dataRoot,'diagnostics','attachments',id+'.sealed');
    if(fs.statSync(file).size>48*1024*1024)throw new Error('invalid_attachment');
    const packet=JSON.parse(fs.readFileSync(file,'utf8'));
    if(packet.header?.vault!==this.metadata.id||packet.header?.lane!=='diagnostics'||packet.header?.id!==id)throw new Error('invalid_attachment');
    const value=openPacket(packet,this.secrets.privateKey,this.metadata.capturePublicKey);
    if(!Number.isSafeInteger(value.from)||!Number.isSafeInteger(value.to)||!containsInterval(windows,value.from,value.to))throw new Error('grant_date_forbidden');
    return {...value,name:'trafficwatch-pktmon-'+id+'.etl',packetPayload:false};
  }
  deleteAttachment(id,windows){
    this.attachment(id,windows); // Validates signature, ownership and the complete evidence interval.
    fs.unlinkSync(path.join(this.dataRoot,'diagnostics','attachments',id+'.sealed'));
    return {ok:true,id};
  }
  close(){this.db.close();}
}

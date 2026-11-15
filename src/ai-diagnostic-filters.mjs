import {inflateRawSync} from 'node:zlib';
import {diagnosticTriggers} from './ai-diagnostic-events.mjs';

const fields=['provider','harness','gateway','category'];
function timeClause(periods,prefix=''){
  return {sql:'('+periods.map(()=>`(${prefix}at>=? AND ${prefix}at<? AND (${prefix}end_at IS NULL OR ${prefix}end_at<?))`).join(' OR ')+')',params:periods.flatMap(p=>[p.from,p.to,p.to])};
}

// Derived indexes live inside the same encrypted database. An incident's tags
// retain the time and identity of the triggering evidence, so a date-limited
// visitor cannot infer a trigger from an excluded day through a filter.
export class DiagnosticFilters {
  constructor(db){
    this.db=db;this.pending=true;db.exec(`CREATE TABLE IF NOT EXISTS diagnostic_filter_entries(event_id TEXT NOT NULL,item_id TEXT NOT NULL,at INTEGER NOT NULL,end_at INTEGER,provider TEXT NOT NULL,harness TEXT NOT NULL,gateway TEXT NOT NULL,category TEXT NOT NULL,unknown_time INTEGER NOT NULL,PRIMARY KEY(event_id,item_id,category));
      CREATE INDEX IF NOT EXISTS diagnostic_filter_parent ON diagnostic_filter_entries(event_id,at);
      CREATE TABLE IF NOT EXISTS diagnostic_filter_indexed(id TEXT PRIMARY KEY);`);
    this.insert=db.prepare('INSERT OR REPLACE INTO diagnostic_filter_entries VALUES (?,?,?,?,?,?,?,?,?)');
    this.remove=db.prepare('DELETE FROM diagnostic_filter_entries WHERE event_id=?');
    this.mark=db.prepare('INSERT OR IGNORE INTO diagnostic_filter_indexed VALUES (?)');
  }
  index(event){
    if(!['request','incident','log','probe'].includes(event.kind))return;
    this.db.exec('SAVEPOINT diagnostic_filter_write');
    try{
      this.remove.run(event.id);
      const items=event.kind==='incident'?(event.evidence||[]).filter(item=>diagnosticTriggers(item).length):[event];
      for(const row of items){
        if(!Number.isSafeInteger(row.at))continue;
        const categories=event.kind==='incident'?diagnosticTriggers(row):[row.category,...(row.captureReasons||[])];
        for(const category of new Set(categories.filter(value=>typeof value==='string'&&value.length&&value.length<=96))){
          this.insert.run(event.id,String(row.id||event.id),row.at,Number.isSafeInteger(row.end)?row.end:null,String(row.provider||row.host||''),String(row.harness||''),String(row.gateway||''),category,row.timeSource==='unknown'?1:0);
        }
      }
      if(event.kind==='incident'&&!items.length)this.insert.run(event.id,event.id,event.at,null,String(event.provider||''),String(event.harness||''),String(event.gateway||''),'evidence_uncertain',1);
      this.mark.run(event.id);
      this.db.exec('RELEASE diagnostic_filter_write');
    }catch(error){this.db.exec('ROLLBACK TO diagnostic_filter_write;RELEASE diagnostic_filter_write');throw error;}
  }
  backfill({limit=128,maxMs=40,correct=value=>value}={}){
    if(!this.pending)return false;
    const rows=this.db.prepare("SELECT id FROM events WHERE kind IN ('incident','request','log','probe') AND NOT EXISTS(SELECT 1 FROM diagnostic_filter_indexed i WHERE i.id=events.id) ORDER BY CASE WHEN kind='incident' THEN 0 ELSE 1 END,at DESC LIMIT ?").all(limit),started=performance.now();
    this.db.exec('SAVEPOINT diagnostic_filter_backfill');
    try{
      for(const row of rows){if(performance.now()-started>=maxMs)break;const {payload}=this.db.prepare('SELECT payload FROM events WHERE id=?').get(row.id);this.index(correct(JSON.parse(inflateRawSync(payload,{maxOutputLength:32*1024*1024}))));}
      this.db.exec('RELEASE diagnostic_filter_backfill');
    }catch(error){this.db.exec('ROLLBACK TO diagnostic_filter_backfill;RELEASE diagnostic_filter_backfill');throw error;}
    this.pending=Boolean(this.db.prepare("SELECT 1 FROM events WHERE kind IN ('incident','request','log','probe') AND NOT EXISTS(SELECT 1 FROM diagnostic_filter_indexed i WHERE i.id=events.id) LIMIT 1").get());return this.pending;
  }
  predicate(values,periods,{owner=false}={}){
    const chosen=fields.filter(field=>values[field]);if(!chosen.length)return null;
    const direct=[],directParams=[],incident=[],incidentParams=[];
    for(const field of chosen){
      const value=values[field];if(typeof value!=='string'||value.length>96)throw new Error('invalid_diagnostic_filter');
      if(field==='category'){
        direct.push("(category=? OR EXISTS(SELECT 1 FROM diagnostic_filter_entries t WHERE t.event_id=events.id AND t.category=?))");directParams.push(value,value);
      }else{direct.push(field+'=?');directParams.push(value);}
      incident.push('t.'+field+'=?');incidentParams.push(value);
    }
    const time=timeClause(periods,'t.');
    return {sql:`((kind!='incident' AND ${direct.join(' AND ')}) OR (kind='incident' AND EXISTS(SELECT 1 FROM diagnostic_filter_entries t WHERE t.event_id=events.id AND ${time.sql}${owner?'':' AND t.unknown_time=0'} AND ${incident.join(' AND ')})))`,params:[...directParams,...time.params,...incidentParams]};
  }
  facets(base,params,periods,{owner=false}={}){
    base=base.replace(/\b(at|end_at|kind|time_source)\b/g,'events.$1');
    const time=timeClause(periods,'t.'),result={};let limited=false;
    for(const field of fields){
      const rows=this.db.prepare(`SELECT value FROM (SELECT ${field} value FROM events WHERE ${base} AND kind!='incident' AND ${field}!='' UNION SELECT t.${field} value FROM events JOIN diagnostic_filter_entries t ON t.event_id=events.id WHERE ${base} AND kind='incident' AND ${time.sql}${owner?'':' AND t.unknown_time=0'} AND t.${field}!='') GROUP BY value ORDER BY value COLLATE NOCASE,value LIMIT 201`).all(...params,...params,...time.params);
      limited||=rows.length>200;result[field]=rows.slice(0,200).map(row=>row.value);
    }
    const categories=this.db.prepare(`SELECT kind,category FROM events WHERE ${base} AND kind!='incident' AND category!='' UNION SELECT 'incident' kind,t.category FROM events JOIN diagnostic_filter_entries t ON t.event_id=events.id WHERE ${base} AND kind='incident' AND ${time.sql}${owner?'':' AND t.unknown_time=0'} GROUP BY kind,t.category ORDER BY kind,category LIMIT 801`).all(...params,...params,...time.params);
    const categoryByKind={};for(const row of categories.slice(0,800))(categoryByKind[row.kind]??=[]).push(row.category);
    return {...result,categoryByKind,limited:limited||categories.length>800};
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {normalizeMagpieRequest,normalizeMagpieLog,magpieLogTimestamp,IncidentEngine,errorCategory} from '../src/ai-diagnostic-events.mjs';
import {DiagnosticHistory} from '../src/ai-diagnostic-store.mjs';
import {IncrementalTail} from '../src/ai-log-tail.mjs';

const raw={id:7,time:'2026-11-15T04:00:00Z',provider:'synthetic',agent:'codex',done:true,status:200,tries:[
  {id:'same-provider',start:'2026-11-15T04:00:00Z',done:true,status:502,error:'EOF private-error',ms:20000},
  {id:'same-provider',start:'2026-11-15T04:00:20Z',done:true,status:200,ms:1000,net:{wait:600}}
]};
function cleanup(dir){
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('tw-diag-repair-'));
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
async function withHistory(run){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-diag-repair-'));let history;
  try{

    history=new DiagnosticHistory(dir);
    await run({history,dir});
  }finally{history?.close();cleanup(dir);}
}

test('same-provider retries survive direct writes, repeated snapshots and delayed legacy logs',()=>withHistory(({history})=>{
  const rows=normalizeMagpieRequest(raw),legacy={...rows[1],id:rows[1].legacyId,schemaVersion:1};
  assert.notEqual(rows[0].id,rows[1].id);assert.equal(rows[0].legacyId,rows[1].legacyId);
  history.append([legacy]);
  const period={from:Date.parse(raw.time),to:Date.parse(raw.time)+3600000};
  const query=()=>history.query({windows:[period],...period,kind:'request'});
  assert.equal(query().quality.legacyRequests,1);
  history.append(rows);
  let result=query();assert.equal(result.rows.length,2);assert.equal(new Set(result.rows.map(row=>row.requestId)).size,1);
  assert.deepEqual(result.rows.map(row=>row.category).sort(),['eof','success']);assert.equal(result.quality.legacyRequests,0);
  const updated=normalizeMagpieRequest({...raw,tries:[raw.tries[0],{...raw.tries[1],ms:2000}]});
  assert.equal(updated[1].id,rows[1].id);history.append([legacy,...updated]);
  result=query();assert.equal(result.rows.length,2);assert.equal(result.rows.find(row=>row.category==='success').durationMs,2000);
  assert.doesNotMatch(JSON.stringify(result),/private-error/);
}));

test('Go local dates, ISO offsets and fractions preserve occurrence time; unknown or invalid times stay unknown',()=>{
  const local=new Date(2026,10,15,12,18,41,123).getTime();
  assert.equal(magpieLogTimestamp('2026/11/15 12:18:41.123456 gateway EOF').at,local);
  assert.equal(magpieLogTimestamp('2026-11-15T12:18:41.123+08:00 EOF').at,Date.parse('2026-11-15T04:18:41.123Z'));
  assert.equal(magpieLogTimestamp('[2026-11-15T04:18:41Z] EOF').at,Date.parse('2026-11-15T04:18:41Z'));
  for(const line of ['no timestamp EOF','2026/02/30 01:02:03 EOF','2026/11/15 25:02:03 EOF'])assert.equal(magpieLogTimestamp(line),null);
  const unknown=normalizeMagpieLog('missing date EOF',{observedAt:12345});assert.equal(unknown.at,null);assert.equal(unknown.fault,false);
  const old=normalizeMagpieLog('2026/11/15 12:18:41 EOF',{historicalImport:true,observedAt:local+3600000});
  assert.equal(old.at,new Date(2026,10,15,12,18,41).getTime());assert.notEqual(old.at,old.observedAt);
  assert.equal(errorCategory('',499),'cancelled');
});

test('replayed timestamps replace incorrect logs, delayed legacy logs cannot regress them, exact date filters see only known occurrences',()=>withHistory(({history})=>{
  const row=normalizeMagpieLog('2026-11-14T12:18:41+08:00 relay.example.test EOF',{observedAt:Date.parse('2026-11-15T12:56:52+08:00'),historicalImport:true,hosts:['relay.example.test']});
  const legacy={id:row.id,kind:'log',at:row.observedAt,gateway:'magpie',category:'eof',fault:true};
  const today={from:Date.parse('2026-11-15T00:00:00+08:00'),to:Date.parse('2026-11-16T00:00:00+08:00')};
  history.put(legacy);history.put({...legacy,id:'unrecoverable'});
  let result=history.query({windows:[today],from:today.from,to:today.to,owner:true});
  assert.equal(result.quality.unknownLogTimes,2);assert(result.rows.every(row=>row.timeSource==='unknown'&&!row.fault));
  assert.equal(history.query({windows:[today],from:today.from,to:today.to}).rows.length,0);
  history.put(row);history.put(legacy);
  result=history.query({windows:[today],from:today.from,to:today.to,owner:true});assert.equal(result.rows.length,1);assert.equal(result.rows[0].id,'unrecoverable');
  const yesterday={from:today.from-86400000,to:today.from};
  const fixed=history.query({windows:[yesterday],from:yesterday.from,to:yesterday.to}).rows;
  assert.equal(fixed.length,1);assert.equal(fixed[0].at,row.at);assert.equal(fixed[0].historicalImport,true);
  history.put({id:'legacy-incident',kind:'incident',at:today.from+1000,from:today.from,to:today.to-1,evidence:[legacy],triggers:['eof']});
  const incident=history.query({windows:[today],from:today.from,to:today.to,eventId:'legacy-incident'}).rows[0];
  assert.equal(incident.evidence.length,0);assert.deepEqual(incident.triggers,[]);assert.equal(incident.legacyEvidence,true);
}));

test('opening a real older SQLite schema flags unknown log time and supports corrected replay',()=>withHistory(({history,dir})=>{
  const row=normalizeMagpieLog('2026/11/15 12:18:41 EOF');
  history.put({id:row.id,kind:'log',at:row.at+3600000,category:'eof',fault:true});
  history.db.exec('ALTER TABLE events DROP COLUMN schema_version;ALTER TABLE events DROP COLUMN time_source;DROP TABLE superseded_events');history.close();
  const upgraded=new DiagnosticHistory(dir);
  try{
    // Cover both fixture timestamps regardless of the runner's clock or zone.
    const period={from:row.at,to:row.at+2*3600000};
    const query=()=>upgraded.query({windows:[period],...period,owner:true});
    let result=query();assert.equal(result.quality.unknownLogTimes,1);
    upgraded.put(row);result=query();assert.equal(result.quality.unknownLogTimes,0);assert.equal(result.rows[0].at,row.at);
  }finally{upgraded.close();}
}));

test('slow successful requests capture surrounding evidence while historical backfill does not trigger new incidents',()=>{
  let now=Date.parse('2026-11-15T04:01:00Z');const saved=[],engine=new IncidentEngine({now:()=>now,persist:event=>saved.push(event)});
  const slow=normalizeMagpieRequest({...raw,tries:[{...raw.tries[1],ms:40000,ttft:35000,net:{connect:200,tls:300,wait:20000}}]})[0];
  engine.observe({...slow,historicalImport:true});assert.equal(saved.length,0);
  engine.observe({id:'before',kind:'tcp',at:now-1000,category:'socket'});
  engine.observe(slow);assert.equal(saved.length,1);assert.equal(slow.fault,false);
  assert(saved[0].triggers.includes('slow_first_content'));assert(saved[0].triggers.includes('slow_response'));assert(!saved[0].triggers.includes('success'));
  assert(saved[0].evidence.some(row=>row.id==='before'));
  now+=360000;engine.tick();assert.equal(saved.at(-1).state,'complete');
});

test('multi-chunk startup and rotation backfill is historical; appended failures remain live',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-diag-repair-')),file=path.join(dir,'app.log'),rows=[];
  try{
    fs.writeFileSync(file,'old-a\nold-b\n');const tail=new IncrementalTail(file,{maxRead:7,onLine:(line,context)=>rows.push({line,...context})});
    while(await tail.poll()){}
    assert.deepEqual(rows.map(row=>row.historicalImport),[true,true]);
    fs.appendFileSync(file,'new-c\n');await tail.poll();assert.equal(rows.at(-1).historicalImport,false);
    fs.renameSync(file,file+'.old');fs.writeFileSync(file,'rotated\n');while(await tail.poll()){}
    assert.equal(rows.at(-1).historicalImport,true);
    const checkpoint=tail.checkpoint();fs.appendFileSync(file,'during-stop\n');const resumed=new IncrementalTail(file,{...checkpoint,onLine:(line,context)=>rows.push({line,...context})});await resumed.poll();
    assert.equal(rows.at(-1).historicalImport,true);fs.appendFileSync(file,'after-resume\n');await resumed.poll();assert.equal(rows.at(-1).historicalImport,false);
  }finally{cleanup(dir);}
});

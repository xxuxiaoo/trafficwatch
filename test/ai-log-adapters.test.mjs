import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {zstdCompressSync} from 'node:zlib';
import {normalizeCcSwitchRequest,normalizeCodexLog,normalizeClaudeRecord,normalizeDshRecord} from '../src/ai-log-adapters.mjs';
import {DiagnosticLogSources} from '../src/ai-log-sources.mjs';
import {IncrementalZstdTail} from '../src/ai-zstd-tail.mjs';
import {collectionSnapshot,requestCoverage} from '../src/ai-diagnostic-quality.mjs';
import {EvidenceRing} from '../src/ai-diagnostic-events.mjs';
import {DiagnosticHistory} from '../src/ai-diagnostic-store.mjs';

const at=Date.now()-60000,secret='private-secret-credential-content';
function cleanup(dir){assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('tw-log-adapters-'));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
test('CC Switch separates actual proxy requests from imported sessions and preserves only metadata',()=>{
  const input={request_id:'synthetic',provider_id:'provider-id',provider_name:'Test relay',app_type:'claude',created_at:Math.floor(at/1000),status_code:502,data_source:'proxy',error_message:'EOF '+secret,duration_ms:25000,first_token_ms:0,session_id:secret,settings_config:secret};
  const row=normalizeCcSwitchRequest(input);assert.equal(row.gateway,'cc-switch');assert.equal(row.category,'eof');assert.equal(row.provider,'Test relay');assert.equal(row.durationMs,25000);assert.equal(row.attempt,null);assert.equal(row.phaseEvidence,'unavailable');
  for(const source of ['codex_session','dsh_session','session_log',null])assert.equal(normalizeCcSwitchRequest({...input,data_source:source}),null);
  assert.doesNotMatch(JSON.stringify(row),/private-secret|settings_config|session_id/);
});
test('Codex matches transport diagnostics, keeps nanosecond ordering and ignores prompt/SSE lookalikes',()=>{
  const row=normalizeCodexLog({id:1,ts:Math.floor(at/1000),ts_nanos:123456789,target:'codex_http_client::client',level:'DEBUG',feedback_log_body:'HTTP request completed method=POST url=https://example.test/responses status=502 Bad Gateway headers={"authorization":"'+secret+'"}'});
  assert.equal(row.status,502);assert.equal(row.at%1000,123);assert.equal(row.category,'gateway_error');assert.doesNotMatch(JSON.stringify(row),/authorization|example.test|private-secret/);
  assert.equal(normalizeCodexLog({id:2,ts:at,target:'codex_core::stream_events_utils',level:'DEBUG',feedback_log_body:'SSE event: {"delta":"EOF retrying 2/5 status=502"}'}),null);
  assert.equal(normalizeCodexLog({id:3,ts:at,target:'codex_core::tools::parallel',level:'ERROR',feedback_log_body:'EOF'}),null);
  const retry=normalizeCodexLog({id:4,ts:at,target:'codex_core::stream_events_utils',level:'WARN',feedback_log_body:'stream disconnected before completion: connection reset; retrying 2/5'});assert.equal(retry.retry,2);assert.equal(retry.category,'reset');
});
test('Claude API error envelopes and DSH durable retries/terminal failures exclude conversation content',()=>{
  const row={type:'assistant',isApiErrorMessage:true,uuid:'a',timestamp:new Date(at).toISOString(),error:'unknown',message:{content:[{type:'text',text:'API Error: 503 '+secret}]}};
  const claude=normalizeClaudeRecord(row);assert.equal(claude.status,503);assert.equal(claude.category,'upstream_busy');assert.equal(normalizeClaudeRecord({...row,type:'user'}),null);
  const dsh=normalizeDshRecord({type:'llm/retry',time:at,seq:5,data:{retryId:'chain',retry:2,delayMs:3000,provider:secret,failure:{code:'UPSTREAM',status:502,message:secret}}},{sourceKey:'f'});
  assert.equal(dsh.retry,2);assert.equal(dsh.status,502);assert.equal(dsh.delayMs,3000);assert(dsh.retryChain);
  const terminal=normalizeDshRecord({type:'turn/end',seq:6,time:at,data:{reason:{kind:'error',error:{code:'DNS',message:'ENOTFOUND '+secret}}}});assert.equal(terminal.category,'dns_error');
  assert.equal(normalizeDshRecord({type:'assistant/message',time:at,data:{message:{content:'HTTP 502'}}}),null);
  assert.doesNotMatch(JSON.stringify([claude,dsh,terminal]),/private-secret|"message"|"content"/);
  let unknown=0;assert.equal(normalizeClaudeRecord({...row,timestamp:'invalid'},{onInvalidTime:()=>unknown++}),null);assert.equal(unknown,1);
});
test('streaming DSH Zstd tail follows appended frames, partial input, restart and file replacement',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-log-adapters-')),file=path.join(dir,'session.v4.jsonl.zstd'),rows=[];let tail,restarted;
  try{
    const original=zstdCompressSync(Buffer.from('第一行\n第二行\n'));fs.writeFileSync(file,original);
    tail=new IncrementalZstdTail(file,{maxRead:7,onLine:(line,context)=>rows.push({line,...context})});while(await tail.poll()){}
    assert.deepEqual(rows.map(r=>r.line),['第一行','第二行']);assert(rows.every(r=>r.historicalImport));
    const next=zstdCompressSync(Buffer.from('live\n'));fs.appendFileSync(file,next.subarray(0,4));await tail.poll();assert.equal(rows.length,2);fs.appendFileSync(file,next.subarray(4));while(await tail.poll()){}assert.equal(rows.at(-1).line,'live');assert.equal(rows.at(-1).historicalImport,false);
    const checkpoint=tail.checkpoint();tail.close();restarted=new IncrementalZstdTail(file,{...checkpoint,maxRead:9,onLine:(line,context)=>rows.push({line,...context})});while(await restarted.poll()){}assert.equal(rows.length,3);
    fs.appendFileSync(file,zstdCompressSync(Buffer.from('after-restart\n')));while(await restarted.poll()){}assert.equal(rows.length,4);assert.equal(rows.at(-1).historicalImport,false);
    fs.renameSync(file,file+'.old');fs.writeFileSync(file,zstdCompressSync(Buffer.from('rotated\n')));while(await restarted.poll()){}assert.equal(rows.at(-1).line,'rotated');assert.equal(rows.at(-1).historicalImport,true);
  }finally{tail?.close();restarted?.close();cleanup(dir);}
});
test('source discovery, readonly SQL cursors, metadata-only filtering and live append work together',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-log-adapters-')),events=[];let source,cc,code;
  const write=(relative,text)=>{const file=path.join(dir,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
  try{
    write('.cc-switch/cc-switch.db','');cc=new DatabaseSync(path.join(dir,'.cc-switch','cc-switch.db'));cc.exec('CREATE TABLE proxy_request_logs(request_id TEXT,provider_id TEXT,app_type TEXT,created_at INTEGER,status_code INTEGER,data_source TEXT,error_message TEXT);CREATE TABLE providers(id TEXT,app_type TEXT,name TEXT)');
    cc.prepare('INSERT INTO proxy_request_logs VALUES (?,?,?,?,?,?,?)').run('cc1','p','codex',Math.floor(at/1000),502,'proxy','EOF '+secret);cc.prepare('INSERT INTO proxy_request_logs VALUES (?,?,?,?,?,?,?)').run('imported','p','codex',Math.floor(at/1000),200,'codex_session','');cc.prepare('INSERT INTO providers VALUES (?,?,?)').run('p','codex','Test relay');
    write('.codex/logs_2.sqlite','');code=new DatabaseSync(path.join(dir,'.codex','logs_2.sqlite'));code.exec('CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,target TEXT,level TEXT,feedback_log_body TEXT)');
    code.prepare('INSERT INTO logs VALUES (?,?,?,?,?)').run(1,Math.floor(at/1000),'codex_http_client::client','DEBUG','HTTP request completed status=200 OK');
    const claude=write('.claude/projects/synthetic/a.jsonl',JSON.stringify({type:'system',subtype:'api_error',uuid:'c1',timestamp:new Date(at).toISOString(),error:{status:502,message:secret}})+'\n'+JSON.stringify({type:'user',content:secret})+'\n');
    write('.dsh/sessions/workspace/session-a/session.v4.jsonl.zstd',zstdCompressSync(Buffer.from(JSON.stringify({type:'llm/retry',time:at,seq:1,data:{retry:1,failure:{status:503,message:secret}}})+'\n')));
    source=new DiagnosticLogSources({ownerProfile:dir,onEvent:event=>events.push(event)});for(let i=0;i<5;i++)await source.poll();assert.equal(events.length,4);assert(events.every(e=>e.historicalImport));assert.equal(events.find(e=>e.gateway==='cc-switch').provider,'Test relay');assert.doesNotMatch(JSON.stringify(events),/private-secret|imported/);
    fs.appendFileSync(claude,JSON.stringify({type:'system',subtype:'api_error',uuid:'c2',timestamp:new Date().toISOString(),error:{status:429}})+'\n');await source.poll();assert.equal(events.length,5);assert.equal(events.at(-1).historicalImport,false);
    const checkpoints=source.checkpoint();source.close();source=new DiagnosticLogSources({ownerProfile:dir,onEvent:event=>events.push(event),checkpoints});for(let i=0;i<4;i++)await source.poll();assert.equal(events.length,5);
    assert(source.snapshot().every(s=>s.state==='caught_up'));assert.doesNotMatch(JSON.stringify(checkpoints),/private-secret|workspace|session-a/);
  }finally{source?.close();cc?.close();code?.close();cleanup(dir);}
});
test('collection checks distinguish source limitations and verify system heartbeat, drops and actual TCP matching',()=>{
  const now=Date.now(),ring=new EvidenceRing(),targets=[{host:'relay.test',ips:['203.0.113.1']}];
  const event={kind:'request',at:now-500,end:now,phaseEvidence:'unavailable',gateway:'cc-switch',host:'relay.test'};
  let result=requestCoverage(event,{ring,startedAt:now-60000,traceState:'recording',lastTraceAt:now,targets,now});assert.equal(result.phase,'not_exposed');assert.equal(result.system,'no_matching_tcp');
  ring.add({kind:'tcp',at:now-200,source:'192.0.2.1',destination:'203.0.113.1'},now);result=requestCoverage(event,{ring,startedAt:now-60000,traceState:'recording',lastTraceAt:now,targets,now});assert.equal(result.system,'same_target_window');
  assert.equal(requestCoverage(event,{ring,startedAt:now-60000,traceState:'recording',lastTraceAt:now-30000,targets,now}).system,'collector_unavailable');
  const snapshot=collectionSnapshot({sources:[{id:'codex',state:'caught_up',lastPollAt:now},{id:'dsh',state:'limited',parseFailures:2}],traceState:'recording',lastTraceAt:now-30000,pktmonState:'recording',pktmonCheckedAt:now,metrics:{traceEventsLost:2},now});
  assert.equal(snapshot.issueCount,2);assert.equal(snapshot.sources.find(s=>s.id==='traceevent').state,'heartbeat_stale');assert.equal(snapshot.fault,false);
});
test('SQLite history checks missing retries and phase/TCP coverage without inventing gaps at selected date boundaries',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-log-adapters-'));let history;
  try{
    history=new DiagnosticHistory(dir);
    const start=Date.now()-60000,windows=[{from:start,to:start+30000}],base={kind:'request',schemaVersion:2,gateway:'magpie',requestId:'chain',requestAt:start+1000,requestEnd:start+10000,expectedAttempts:3,coverage:{phase:'missing',system:'collector_unavailable'}};
    history.put({...base,id:'try1',at:start+1000,end:start+2000,attempt:1});history.put({...base,id:'try3',at:start+6000,end:start+10000,attempt:3});
    history.put({...base,id:'boundary',requestId:'outside-chain',requestAt:start-10000,requestEnd:start+10000,at:start+5000,expectedAttempts:5,attempt:5});
    let result=history.query({windows,from:start,to:start+30000});assert.equal(result.quality.missingRetryAttempts,1);assert.equal(result.quality.retryChainsWithGaps,1);assert.equal(result.quality.phaseMissing,3);assert.equal(result.quality.systemUnavailable,3);
    history.put({...base,id:'try2',at:start+2000,end:start+5000,attempt:2,coverage:{phase:'available',system:'same_target_window'}});result=history.query({windows,from:start,to:start+30000});assert.equal(result.quality.missingRetryAttempts,0);assert.equal(result.quality.requestsChecked,4);
    history.put({kind:'status',category:'collection_health',id:'check',at:start+20000,issueCount:0,sources:[{id:'dsh',lastEventAt:start-1000,modifiedAt:start-1000,lastPollAt:start+20000}]});
    const check=history.query({windows,from:start,to:start+30000,kind:'status',category:'collection_health',limit:1});assert.equal(check.rows[0].sources[0].lastEventAt,null);assert.equal(check.rows[0].sources[0].modifiedAt,null);assert.equal(check.rows[0].sources[0].lastPollAt,start+20000);assert.equal(check.requestSummary.length,0);
    const list=history.query({windows,from:start,to:start+30000,kind:'status',category:'collection_health',limit:50});assert.equal(list.requestSummary.reduce((sum,row)=>sum+row.count,0),4,'the full self-check history still reports requests for the selected period');
    assert.equal(history.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  }finally{history?.close();cleanup(dir);}
});

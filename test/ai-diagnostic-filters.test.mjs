import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createVaultKeys} from '../src/vault-crypto.mjs';
import {DiagnosticHistory} from '../src/ai-diagnostic-store.mjs';

const start=Date.parse('2026-11-13T00:00:00+08:00'),day=86400000;
const window={from:start,to:start+3*day};
async function withHistory(run){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-diagnostic-filters-'));let history;
  try{const {metadata,secrets}=await createVaultKeys('synthetic-filter-password');history=new DiagnosticHistory(dir,metadata,secrets);await run(history);}
  finally{history?.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('tw-diagnostic-filters-'));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
const query=(history,options={})=>history.query({windows:[window],from:window.from,to:window.to,owner:true,...options});
const request=(id,category,extra={})=>({id,kind:'request',schemaVersion:2,at:start+10000,category,provider:'Relay A',harness:'codex',gateway:'magpie',fault:category==='gateway_error'||category==='eof',...extra});
const incident=(id,evidence,extra={})=>({id,kind:'incident',schemaVersion:2,at:start+20000,from:start,to:start+60000,provider:'Relay A',harness:'codex',gateway:'magpie',state:'complete',evidence,...extra});

test('incident filters use the triggering evidence and combine identity and cause on the same attempt',()=>withHistory(history=>{
  const a=request('a','eof'),b=request('b','gateway_error',{provider:'Relay B',harness:'claude',gateway:'cc-switch'});
  history.put(incident('mixed',[a,b]));
  assert.deepEqual(query(history,{kind:'incident',provider:'Relay B',harness:'claude',gateway:'cc-switch',category:'gateway_error'}).rows.map(row=>row.id),['mixed']);
  assert.equal(query(history,{kind:'incident',provider:'Relay A',category:'gateway_error'}).rows.length,0);
  assert.equal(query(history,{kind:'incident',provider:'Relay B',harness:'codex'}).rows.length,0);
  assert.equal(query(history,{kind:'incident',category:'eof'}).rows.length,1);
  history.put(incident('mixed',[a]));
  assert.equal(query(history,{kind:'incident',category:'gateway_error'}).rows.length,0,'updating a recording incident replaces old trigger tags');
}));

test('slow successes can be filtered by their capture reason without reclassifying successful requests',()=>withHistory(history=>{
  const slow=request('slow','success',{fault:false,captureReasons:['slow_send','slow_first_content']}),fast=request('fast','success',{fault:false});
  history.put(slow);history.put(fast);history.put(incident('slow-incident',[slow,fast]));
  assert.deepEqual(query(history,{kind:'request',category:'slow_send'}).rows.map(row=>[row.id,row.category]),[['slow','success']]);
  assert.equal(query(history,{kind:'request',category:'success'}).rows.length,2);
  assert.equal(query(history,{kind:'incident',category:'slow_first_content'}).rows.length,1);
  assert.equal(query(history,{kind:'incident',category:'success'}).rows.length,0);
}));

test('filter choices cover the complete time range, independent of pagination and selected conditions',()=>withHistory(history=>{
  for(let i=0;i<55;i++)history.put(request('new-'+i,'success',{at:start+100000+i}));
  history.put(request('old','gateway_error',{at:start+1,provider:'Relay B',harness:'claude',gateway:'cc-switch'}));
  const result=query(history,{kind:'request',provider:'Relay A',category:'success',limit:2});
  assert.equal(result.rows.length,2);assert(result.next);assert.deepEqual(result.facets.provider,['Relay A','Relay B']);
  assert.deepEqual(result.facets.harness,['claude','codex']);assert.deepEqual(result.facets.gateway,['cc-switch','magpie']);
  assert(result.facets.categoryByKind.request.includes('gateway_error'));
  assert.deepEqual(query(history,{kind:'request',provider:'absent'}).facets.provider,['Relay A','Relay B']);
  assert.equal(query(history,{kind:'request',provider:'Relay A',category:'success',limit:2,cursor:result.next}).summary[0].count,55);
  const older=query(history,{from:start,to:start+10});assert.deepEqual(older.facets.provider,['Relay B']);
}));

test('visitor date filters and choices cannot reveal excluded-day or unknown-time trigger identities',()=>withHistory(history=>{
  const allowed=request('allowed','eof'),excluded=request('excluded','gateway_error',{at:start+day+1000,provider:'Excluded Relay',harness:'excluded-harness',gateway:'excluded-gateway'});
  history.put(incident('crossing',[allowed,excluded],{to:start+2*day+1000}));
  history.put({kind:'log',id:'unknown',at:start+30000,category:'reset',provider:'Unknown time relay',fault:true});
  const periods=[{from:start,to:start+day},{from:start+2*day,to:start+3*day}],options={owner:false,windows:periods};
  let result=query(history,{...options,kind:'incident'});
  assert.deepEqual(result.facets.provider,['Relay A']);assert.deepEqual(result.facets.category,['eof']);
  assert.deepEqual(result.facets.categoryByKind.incident,['eof']);assert.deepEqual(result.rows[0].triggers,[]);
  assert.equal(query(history,{...options,kind:'incident',provider:'Excluded Relay'}).rows.length,0);
  assert.equal(query(history,{...options,kind:'incident',category:'gateway_error'}).rows.length,0);
  result=query(history,{...options,eventId:'crossing'});assert.deepEqual(result.rows[0].evidence.map(row=>row.id),['allowed']);
  assert(query(history).facets.provider.includes('Excluded Relay'));
  assert(query(history).facets.provider.includes('Unknown time relay'));
}));

test('legacy filter backfill is bounded, prioritizes incidents and completes old slow-request filtering',()=>withHistory(history=>{
  history.put(incident('legacy-incident',[request('trigger','gateway_error')]));
  for(let i=0;i<12;i++)history.put(request('recent-'+i,'success',{at:start+100000+i,captureReasons:['slow_response']}));
  history.db.exec('DELETE FROM diagnostic_filter_entries;DELETE FROM diagnostic_filter_indexed');
  assert.equal(history.filters.backfill({limit:1,maxMs:Infinity}),true);
  assert.equal(history.db.prepare("SELECT COUNT(*) count FROM diagnostic_filter_entries WHERE event_id='legacy-incident'").get().count,1);
  assert.equal(history.filters.backfill({limit:1,maxMs:0}),true);
  for(let i=0;i<10;i++)if(!query(history).filterIndexPending)break;
  const result=query(history,{kind:'request',category:'slow_response'});assert.equal(result.filterIndexPending,false);assert.equal(result.rows.length,12);
  assert.equal(query(history,{kind:'incident',category:'gateway_error'}).rows.length,1);
}));

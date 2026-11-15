import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {normalizeMagpieRequest,EvidenceRing,IncidentEngine,errorCategory} from '../src/ai-diagnostic-events.mjs';
import {IncrementalTail} from '../src/ai-log-tail.mjs';
import {DiagnosticHistory,DiagnosticSpool} from '../src/ai-diagnostic-store.mjs';
import {createVaultKeys} from '../src/vault-crypto.mjs';
import {GrantRegistry} from '../src/vault-grants.mjs';
import {patchProfileScript} from '../src/relay-clash-overlay.mjs';

test('failed attempt remains distinct when retry succeeds; no credentials, content, paths or raw errors copied',()=>{
  const rows=normalizeMagpieRequest({id:'request',time:'2026-11-15T01:00:00Z',done:true,provider:'synthetic',agent:'codex',prompt:'secret prompt',folder:'private-path',session:'private-session',tries:[{id:'a',start:'2026-11-15T01:00:00Z',done:true,status:502,ms:20000,error:'EOF sk-secret Bearer private'}, {id:'b',start:'2026-11-15T01:00:20Z',done:true,status:200,ms:1000,net:{tls:200,wait:500,reused:false,token:'secret'}}]});
  assert.equal(rows.length,2);assert.equal(rows[0].category,'eof');assert.equal(rows[0].phaseEvidence,'unavailable');assert.equal(rows[0].timings.tls,null);assert.equal(rows[1].category,'success');assert.equal(rows[1].timings.tls,200);
  assert.doesNotMatch(JSON.stringify(rows),/secret|prompt|private-/);assert.notEqual(rows[0].id,rows[1].id);
  assert.equal(errorCategory('',503),'upstream_busy');assert.equal(errorCategory('context canceled',502),'cancelled');assert.equal(errorCategory('',429),'rate_limit');
});

test('incident preserves before and after evidence, merges nearby failures and bounds memory',()=>{
  let now=1000000;const saved=[],ring=new EvidenceRing({maxEvents:10,maxBytes:10000}),engine=new IncidentEngine({ring,persist:event=>saved.push(event),now:()=>now});
  engine.observe({id:'pre',kind:'tcp',at:now-60000});engine.observe({id:'fault',kind:'request',at:now-20000,end:now,category:'eof',fault:true});const id=saved[0].id;
  now+=20000;engine.observe({id:'retry',kind:'request',at:now,category:'success'});engine.observe({id:'fault2',kind:'probe',at:now,category:'tls_error',fault:true});assert.equal(saved.at(-1).id,id);
  now+=310000;engine.tick();assert.equal(saved.at(-1).state,'complete');assert(saved.at(-1).evidence.some(row=>row.id==='pre'));assert(saved.at(-1).evidence.some(row=>row.id==='retry'));assert.equal(engine.active,null);
  for(let i=0;i<100;i++)ring.add({id:String(i),at:now},now);assert.equal(ring.rows.length,10);assert(ring.evicted>=90);
});

test('incremental log reading survives partial UTF-8, restart cursor, truncation and rotation',{timeout:5000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-diag-tail-')),file=path.join(dir,'log'),rows=[],gaps=[];
  try{
    fs.writeFileSync(file,'一\n半');const tail=new IncrementalTail(file,{onLine:line=>rows.push(line),onGap:gap=>gaps.push(gap)});await tail.poll();assert.deepEqual(rows,['一']);
    fs.appendFileSync(file,'行\n');await tail.poll();assert.deepEqual(rows,['一','半行']);const cursor=tail.checkpoint();
    const restarted=new IncrementalTail(file,{...cursor,onLine:line=>rows.push(line),onGap:gap=>gaps.push(gap)});await restarted.poll();assert.equal(rows.length,2);
    fs.writeFileSync(file,'新\n');await restarted.poll();assert.equal(rows.at(-1),'新');assert(gaps.includes('log_rotation'));
    fs.renameSync(file,file+'.old');fs.writeFileSync(file,'轮转\n');await restarted.poll();assert.equal(rows.at(-1),'轮转');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('signed diagnostic queue and indexed history remain encrypted; exact date scopes redact incident evidence',{timeout:20000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-diag-vault-'));let spool,history;
  try{
    const {metadata,secrets}=await createVaultKeys('synthetic-test-password');const signing=crypto.generateKeyPairSync('ed25519');metadata.capturePublicKey=signing.publicKey.export({format:'pem',type:'spki'});
    spool=new DiagnosticSpool(dir,metadata,{signingKey:signing.privateKey});history=new DiagnosticHistory(dir,metadata,secrets);
    const minute=60000,a=Date.parse('2026-11-10T01:00:00Z'),b=a+86400000;
    spool.append([{id:'inside',kind:'request',at:a,provider:'private-provider.test',category:'eof'},{id:'outside',kind:'request',at:b,provider:'outside-provider.test',category:'success'},{id:'incident',kind:'incident',at:a,from:a-minute,to:b+minute,evidence:[{id:'a',at:a,private:'inside'},{id:'b',at:b,private:'excluded'}]}]);
    assert.doesNotMatch(fs.readFileSync(path.join(dir,'diagnostics','ingest.sqlite-wal')).toString('utf8'),/private-provider|outside-provider/);
    assert.equal(history.drain(),1);const result=history.query({windows:[{from:a-minute,to:a+minute}],from:0,to:b+minute});assert.equal(result.rows.length,2);assert.equal(result.rows.find(row=>row.kind==='incident').evidence,undefined);const incident=history.query({windows:[{from:a-minute,to:a+minute}],from:0,to:b+minute,eventId:'incident'}).rows[0];assert.equal(incident.evidence.length,1);assert.doesNotMatch(JSON.stringify(result),/outside-provider|excluded/);assert.equal(result.requestSummary[0].count,1);
    assert.equal(history.drain(),0);history.close();history=null;assert.doesNotMatch(fs.readFileSync(path.join(dir,'diagnostics','history.vault.sqlite')).toString('utf8'),/private-provider|outside-provider/);
  }finally{spool?.close();history?.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('traffic-only AI visitor cannot read diagnostics; lock, date and operation policies apply',()=>{
  let now=100000000;const registry=new GrantRegistry({now:()=>now});const base={scope:{kind:'windows',windows:[{from:99960000,to:100020000}]},minutes:60,permissions:['read']};
  const traffic=registry.issue({...base,lanes:['clash']});assert.throws(()=>registry.authenticate(traffic.token,{lane:'diagnostics'}),/grant_forbidden/);
  const diagnostic=registry.issue({...base,lanes:['diagnostics'],continueWhenLocked:true});registry.lock();assert(registry.authenticate(diagnostic.token,{lane:'diagnostics',locked:true}));assert.throws(()=>registry.authenticate(diagnostic.token,{lane:'diagnostics',operation:'export'}),/grant_forbidden/);assert.throws(()=>registry.authenticate(diagnostic.token,{lane:'diagnostics',from:100080000,to:100140000}),/grant_date_forbidden/);registry.lock({force:true});assert.throws(()=>registry.authenticate(diagnostic.token,{lane:'diagnostics'}),/grant_expired/);
});

test('Clash profile overlay is repeatable, preserves original settings, rollback removes only marked code',()=>{
  const original='// custom user setting\nfunction main(config) { config.keep = 42; return config; }\n',hosts=['relay.example.test'],ips=['203.0.113.4'];
  const patched=patchProfileScript(original,hosts,ips);assert(patched.includes('config.keep = 42'));assert.equal((patched.match(/BEGIN TrafficWatch/g)||[]).length,1);
  const twice=patchProfileScript(patched,hosts,ips);assert.equal((twice.match(/BEGIN TrafficWatch/g)||[]).length,1);assert.equal(twice,patchProfileScript(twice,hosts,ips));
  const config={dns:{'fake-ip-filter':['existing']},tun:{'route-exclude-address':['192.0.2.1/32']}};const main=new Function(patched+'; return main;')();main(config);assert(config.dns['fake-ip-filter'].includes('existing'));assert(config.tun['route-exclude-address'].includes('203.0.113.4/32'));assert(config.tun['route-exclude-address'].includes('192.0.2.1/32'));
  assert.doesNotMatch(patchProfileScript(patched,[],[]),/TrafficWatch|relay.example.test/);
});

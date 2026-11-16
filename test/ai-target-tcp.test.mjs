import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {buildProviderTargets,mappedProviderHost} from '../src/ai-provider-targets.mjs';
import {normalizeMagpieRequest,EvidenceRing,IncidentEngine,diagnosticTriggers} from '../src/ai-diagnostic-events.mjs';
import {requestCoverage} from '../src/ai-diagnostic-quality.mjs';
import {normalizeTcpEvent,correctTcpCategory} from '../src/ai-tcp-events.mjs';
import {summarizeTcpRetries,tcpOperationCategory} from '../public/tcp-evidence.mjs';
import {DiagnosticHistory,DiagnosticSpool} from '../src/ai-diagnostic-store.mjs';
import {createVaultKeys} from '../src/vault-crypto.mjs';

const hosts=['relay-a.example.test','relay-b.example.test'];
const config={providers:[
  {id:'relay-responses',name:'Responses relay',baseAPI:'responses',responses:'https://relay-a.example.test/v1/responses?credential=private-secret',anthropic:'https://relay-b.example.test/v1',website:'https://relay-b.example.test',apiKey:'private-secret'},
  {id:'relay-chat',baseAPI:'chat',chat:'https://relay-b.example.test/v1',was:['Former chat name']},
  {id:'relay-claude',baseAPI:'anthropic',anthropic:'https://relay-a.example.test/v1'},
]};
const targetState=[{host:hosts[0],ips:['203.0.113.1']},{host:hosts[1],ips:['203.0.113.2']}];
const now=Date.parse('2026-11-16T04:00:00Z');
const tcp=(extra={})=>({at:now-1000,pid:123,process:'magpie-windows-amd64',source:'192.0.2.10',sourcePort:2000,destination:'203.0.113.1',destinationPort:443,operation:'Reconnect',count:1,bytes:0,...extra});

test('actual Magpie protocol fields select the active endpoint, retain provider aliases and omit all credential fields',()=>{
  const targets=buildProviderTargets(config,hosts);
  assert.equal(targets.get('relay-responses'),hosts[0]);
  assert.equal(mappedProviderHost(targets,'  RESPONSES RELAY  '),hosts[0]);
  assert.equal(targets.get('relay-chat'),hosts[1]);assert.equal(targets.get('former chat name'),hosts[1]);assert.equal(targets.get('relay-claude'),hosts[0]);
  assert.doesNotMatch(JSON.stringify([...targets]),/private-secret|credential|\/v1|apiKey|website/);
});
test('mapping handles nested generic endpoint settings and keyed providers without guessing websites or ambiguous aliases',()=>{
  const targets=buildProviderTargets({providers:{
    'provider-with-key-in-name':{id:'nested',name:'Shared label',settings:{base_url:'https://relay-a.example.test/v1'}},
    second:{id:'second',name:'Shared label',baseURL:'https://relay-b.example.test/v1'},
    websiteOnly:{id:'website',website:'https://relay-a.example.test'},
    inactive:{id:'inactive',baseAPI:'responses',responses:'https://unmanaged.example.test/v1',anthropic:'https://relay-a.example.test/v1'},
    conflicting:{id:'conflicting',chat:'https://relay-a.example.test',anthropic:'https://relay-b.example.test'},
    missingSelected:{id:'missing-selected',baseAPI:'responses',anthropic:'https://relay-a.example.test'},
    legacy:{id:'legacy',baseAPI:'https://relay-b.example.test/v1'},
  }},hosts);
  assert.equal(targets.get('provider-with-key-in-name'),hosts[0]);assert.equal(targets.get('nested'),hosts[0]);
  assert.equal(targets.has('shared label'),false);assert.equal(targets.has('website'),false);assert.equal(targets.has('inactive'),false);
  assert.equal(targets.has('conflicting'),false);assert.equal(targets.has('missing-selected'),false);assert.equal(targets.get('legacy'),hosts[1]);
});
test('each known retry provider maps to its own target and a completed request matches actual same-target TCP evidence',()=>{
  const providerTargets=buildProviderTargets(config,hosts);
  const rows=normalizeMagpieRequest({id:'request',time:new Date(now-30000).toISOString(),provider:'Responses relay',agent:'codex',done:true,tries:[
    {id:'relay-responses',start:new Date(now-30000).toISOString(),done:true,status:502,ms:10000,net:{connect:230,tls:240}},
    {id:'relay-chat',start:new Date(now-19000).toISOString(),done:true,status:200,ms:18000,net:{connect:220,tls:230}},
  ]},{providerTargets});
  assert.deepEqual(rows.map(row=>[row.provider,row.host]),[['relay-responses',hosts[0]],['relay-chat',hosts[1]]]);
  assert.notEqual(rows[0].id,rows[1].id);
  const ring=new EvidenceRing();ring.add(normalizeTcpEvent(tcp({destination:'203.0.113.2'}),{targets:targetState}),now);
  const coverage=requestCoverage(rows[1],{ring,startedAt:now-60000,traceState:'recording',lastTraceAt:now,targets:targetState,now});
  assert.equal(coverage.system,'same_target_window');assert.equal(coverage.phase,'available');
  const unmatched=requestCoverage(rows[0],{ring,startedAt:now-60000,traceState:'recording',lastTraceAt:now,targets:targetState,now});assert.equal(unmatched.system,'no_matching_tcp');
  assert.doesNotMatch(JSON.stringify(rows),/private-secret|credential/);
});
test('Reconnect is a distinct TCP retry that captures AI relay evidence without declaring a failed HTTP request',()=>{
  const event=normalizeTcpEvent({...tcp(),password:'private-secret',headers:{authorization:'private-secret'}},{targets:targetState,id:'retry'});
  assert.equal(event.category,'tcp_connect_retry');assert.equal(event.gateway,'magpie');assert.equal(event.host,hosts[0]);assert.equal(event.fault,false);
  assert.deepEqual(diagnosticTriggers(event),['tcp_connect_retry']);assert.doesNotMatch(JSON.stringify(event),/password|headers|private-secret/);
  assert.equal(tcpOperationCategory('ReconnectIPV6'),'tcp_connect_retry');assert.equal(tcpOperationCategory('Connect'),'socket');assert.equal(tcpOperationCategory('Retransmit'),'retransmit');assert.equal(tcpOperationCategory('Fail'),'tcp_fail');
  const saved=[],engine=new IncidentEngine({now:()=>now,persist:row=>saved.push(row)});engine.observe(event);
  assert.equal(saved.length,1);assert.deepEqual(saved[0].triggers,['tcp_connect_retry']);assert.equal(saved[0].evidence[0].fault,false);
});
test('probe retries, unrelated traffic and shared IPs cannot invent a single AI relay attribution',()=>{
  const probe=normalizeTcpEvent(tcp({process:'TrafficWatch-RelayProbe'}),{targets:targetState});assert.equal(probe.synthetic,true);assert.deepEqual(diagnosticTriggers(probe),[]);
  const background=normalizeTcpEvent(tcp({process:'verge-mihomo'}),{targets:targetState});assert.equal(background.category,'tcp_connect_retry');assert.deepEqual(diagnosticTriggers(background),[]);
  const unknown=normalizeTcpEvent(tcp({destination:'203.0.113.99'}),{targets:targetState});assert.equal(unknown.host,undefined);assert.deepEqual(diagnosticTriggers(unknown),[]);
  const shared=normalizeTcpEvent(tcp(),{targets:[...targetState,{host:'other.example.test',ips:['203.0.113.1']}]});assert.equal(shared.host,undefined);assert.deepEqual(diagnosticTriggers(shared),[]);
});
test('retry summary counts aggregated events by actual socket, preserves time and excludes synthetic probes',()=>{
  const events=[normalizeTcpEvent(tcp({at:now-8000,count:2}),{targets:targetState}),normalizeTcpEvent(tcp({at:now-2000,count:3}),{targets:targetState}),normalizeTcpEvent(tcp({sourcePort:2001}),{targets:targetState}),normalizeTcpEvent(tcp({process:'TrafficWatch-RelayProbe',count:99}),{targets:targetState})];
  const summary=summarizeTcpRetries(events);assert.equal(summary.retries,6);assert.equal(summary.connections,2);assert.equal(summary.flows[0].count,5);assert.equal(summary.flows[0].firstAt,now-8000);assert.equal(summary.flows[0].lastAt,now-2000);
  const legacy=correctTcpCategory({id:'legacy',kind:'tcp',...tcp(),category:'socket',fault:false});assert.equal(legacy.category,'tcp_connect_retry');assert.equal(legacy.operation,'Reconnect');assert.deepEqual(diagnosticTriggers(legacy),[],'relabeling old evidence must not invent a past trigger');
});
test('encrypted import keeps new retry filters and old incident metadata correct within exact visitor dates',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-target-tcp-'));let history,spool;
  try{
    const {metadata,secrets}=await createVaultKeys('synthetic-target-password');const signing=crypto.generateKeyPairSync('ed25519');metadata.capturePublicKey=signing.publicKey.export({format:'pem',type:'spki'});
    history=new DiagnosticHistory(dir,metadata,secrets);spool=new DiagnosticSpool(dir,metadata,{signingKey:signing.privateKey});
    const live=normalizeTcpEvent(tcp(),{targets:targetState,id:'live'}),old={id:'old',kind:'tcp',...tcp({at:now-2000}),category:'socket',fault:false};
    const excluded=normalizeTcpEvent(tcp({at:now+86400000,destination:'203.0.113.2'}),{targets:targetState,id:'excluded'});
    spool.append([{id:'incident',kind:'incident',schemaVersion:2,at:now,from:now-600000,to:now+86460000,state:'complete',evidence:[old,live,excluded]}]);assert.equal(history.drain(),1);
    const options={windows:[{from:now-60000,to:now+60000}],from:now-60000,to:now+60000};
    const found=history.query({...options,kind:'incident',category:'tcp_connect_retry',gateway:'magpie'});assert.equal(found.rows.length,1);assert.equal(found.requestSummary.length,0,'system retries never inflate HTTP request counts');
    const detail=history.query({...options,eventId:'incident'}).rows[0];assert.equal(detail.evidence.length,2);assert(detail.evidence.every(row=>row.category==='tcp_connect_retry'));
    assert.equal(summarizeTcpRetries(detail.evidence).retries,2);assert.doesNotMatch(JSON.stringify(detail),/203\.0\.113\.2|relay-b/);
  }finally{
    spool?.close();history?.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith('tw-target-tcp-'));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

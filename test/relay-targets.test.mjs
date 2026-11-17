import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeRelayHost,normalizeRelayTargets,readRelayTargetConfig,saveRelayTargets,restoreRelayTargets,requestRelayReconcile,activeRelayHosts,isPublicIPv4} from '../src/relay-targets.mjs';
import {reconcileRelayRules} from '../src/relay-clash-overlay.mjs';
import {bypassCycle} from '../src/relay-bypass.mjs';

test('relay manager accepts domains and API URLs while rejecting unsafe and non-public targets',()=>{
  assert.equal(normalizeRelayHost(' HTTPS://Api.Example.COM:443/v1/responses?q=ok '),'api.example.com');
  assert.equal(normalizeRelayHost('api.example.com.'),'api.example.com');
  assert.throws(()=>normalizeRelayHost('https://user:pass@api.example.com/path'),/invalid_relay_host/);
  for(const host of ['localhost','x.local','x.lan','x.home.arpa','*.example.com','127.0.0.1','10.0.0.8','api.example.com/path','http://example.com@127.0.0.1','not a domain'])assert.throws(()=>normalizeRelayHost(host),/invalid_relay_host/);
  assert(isPublicIPv4('93.184.216.34'));for(const ip of ['0.2.3.4','10.0.0.1','100.64.0.1','127.0.0.1','169.254.1.1','172.31.1.1','192.0.2.1','192.168.1.1','198.18.0.1','198.51.100.1','203.0.113.9','224.0.0.1','255.255.255.255'])assert.equal(isPublicIPv4(ip),false,ip);
  assert.throws(()=>normalizeRelayTargets([{name:'one',host:'api.example.com'},{name:'two',host:'API.EXAMPLE.COM'}]),/duplicate_relay_target/);
  assert.throws(()=>normalizeRelayTargets(Array.from({length:65},(_,index)=>({name:'relay '+index,host:`api${index}.example.com`}))),/invalid_relay_targets/);
});

test('relay targets keep stable legacy entries, back up every edit and restore without dropping the current list',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-relay-targets-')),legacy=['one.example.com','two.example.com'];
  try{
    const initial=readRelayTargetConfig(root,legacy);assert.deepEqual(initial.targets.map(target=>target.host),legacy);assert.equal(readRelayTargetConfig(root,legacy).targets[0].id,initial.targets[0].id);
    const next=[...initial.targets,{id:'e01c8b46-1262-4f23-9c4d-647a4d5519ca',name:'New relay',host:'https://new.example.com/v1',enabled:true}];
    const saved=saveRelayTargets(root,next,{legacyHosts:legacy,now:100});assert.deepEqual(activeRelayHosts({DataRoot:root,RelayHosts:legacy}),['one.example.com','two.example.com','new.example.com']);
    assert.equal(saved.backups.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'relay-bypass','backups',`targets-${saved.backups[0].id}.json`),'utf8')).targets.map(target=>target.host),legacy);
    const edited=saveRelayTargets(root,[{...next[0],enabled:false}],{legacyHosts:legacy,now:200});assert.deepEqual(activeRelayHosts({DataRoot:root,RelayHosts:legacy}),[]);assert.equal(edited.backups.length,2);
    assert.throws(()=>saveRelayTargets(root,[],{expectedRevision:saved.revision}),/relay_config_conflict/);assert.equal(readRelayTargetConfig(root).revision,edited.revision);
    const restored=restoreRelayTargets(root,saved.backups[0].id,{legacyHosts:legacy,now:300});assert.deepEqual(restored.targets.map(target=>target.host),legacy);assert.equal(restored.backups.length,3);
    assert.throws(()=>restoreRelayTargets(root,'../../outside'),/invalid_relay_backup/);
    assert.equal(requestRelayReconcile(root,{now:400}),400);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'relay-bypass','refresh.request'),'utf8')),{at:400});
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('removing an owned relay rule restores only its original rules and retains unrelated rules',()=>{
  const original=['DOMAIN,old.example.com,PROXY','DOMAIN,new.example.com,PROXY','RULE-SET,private,DIRECT'];
  const first=reconcileRelayRules(original,{hosts:[],ruleOwnership:{}},['old.example.com','new.example.com']);
  assert.deepEqual(first.rules.slice(0,2),['DOMAIN,old.example.com,DIRECT','DOMAIN,new.example.com,DIRECT']);
  const updated=reconcileRelayRules(first.rules,{hosts:['old.example.com','new.example.com'],ruleOwnership:first.ruleOwnership},['old.example.com']);
  assert.equal(updated.rules.includes('DOMAIN,new.example.com,DIRECT'),false);
  assert(updated.rules.includes('DOMAIN,new.example.com,PROXY'));
  assert(updated.rules.includes('DOMAIN,old.example.com,DIRECT'));
  assert(updated.rules.includes('RULE-SET,private,DIRECT'));
  const rolledBack=reconcileRelayRules(updated.rules,{hosts:['old.example.com'],ruleOwnership:updated.ruleOwnership},[]);
  assert.deepEqual(rolledBack.rules,original);
  assert.deepEqual(rolledBack.ruleOwnership,{});
  const withExisting=['DOMAIN,old.example.com,DIRECT','RULE-SET,private,DIRECT'];
  const applied=reconcileRelayRules(withExisting,{},['old.example.com']);
  const repeated=reconcileRelayRules(applied.rules,{ruleOwnership:applied.ruleOwnership},['old.example.com']);assert.deepEqual(repeated.rules,applied.rules);
  assert.deepEqual(reconcileRelayRules(repeated.rules,{ruleOwnership:repeated.ruleOwnership},[]).rules,withExisting);
});

test('changed relay lists force fresh physical checks and disabling the final target removes managed state',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-relay-cycle-')),adapter={index:10,address:'192.0.2.40',gateway:'192.0.2.1',name:'Synthetic Ethernet',ipv6:[]};
  const calls=[],settings={DataRoot:root,RelayHosts:['old.example.test']};let probes=0,failResolve=false;
  const services={
    discoverPhysical:async()=>adapter,
    physicalDns:async host=>{if(failResolve&&host==='new.example.test')throw new Error('dns_unavailable');return {at:Date.now(),records:[{type:'A',ip:host==='old.example.test'?'93.184.216.34':'93.184.216.35',ttl:600}],cnames:[],ipv6Records:[]};},
    runNetworkScript:async(_script,action,input)=>{calls.push(action);return [{ok:true,checks:input?JSON.parse(fs.readFileSync(input,'utf8')).targets.flatMap(target=>target.ips.map(ip=>({ip,physical:true}))):[]}];},
    applyClashOverlay:async(_settings,options)=>{calls.push(options.rollback?'overlay-rollback':'overlay-apply');return {state:'applied'};},
    productionController:async()=>({candidate:{}}),controllerCall:async()=>({connections:[]}),
    lookup:async host=>({address:host==='old.example.test'?'93.184.216.34':'93.184.216.35'}),
    probeRelay:async(host,ip,_adapter,{onConnected})=>{probes++;onConnected({host,ip,sourcePort:45000});return {source:adapter.address,phase:'complete',status:401};},
  };
  try{
    const first=await bypassCycle(settings,{services});assert.equal(first.state,'verified');assert.equal(probes,1);
    const initial=readRelayTargetConfig(root,settings.RelayHosts);
    saveRelayTargets(root,[...initial.targets,{name:'new',host:'new.example.test'}],{legacyHosts:settings.RelayHosts});
    failResolve=true;await assert.rejects(bypassCycle(settings,{services}),/relay_resolution_incomplete/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'relay-bypass','targets.json'),'utf8')).targets.map(target=>target.host),['old.example.test']);
    failResolve=false;const added=await bypassCycle(settings,{services});assert.equal(added.checks.length,2);assert.equal(added.state,'verified');assert.equal(probes,3);
    saveRelayTargets(root,readRelayTargetConfig(root).targets.map(target=>({...target,enabled:false})));
    const disabled=await bypassCycle(settings,{services});assert.equal(disabled.state,'rolled_back');assert.deepEqual(disabled.targets,[]);assert.deepEqual(calls.slice(-2),['overlay-rollback','Rollback']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'relay-bypass','targets.json'),'utf8')).targets,[]);
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

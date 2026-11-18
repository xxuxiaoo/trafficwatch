import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {diagnosticHealth} from '../public/diagnostic-health.mjs';
import {relayErrorCode,relayResultHealth,readRelayHealth} from '../src/relay-health.mjs';

test('diagnostic health distinguishes a healthy recorder from failed, stale and in-progress bypass checks',()=>{
  const collector={state:'recording',trace:'recording',pktmon:'recording'};
  const value=diagnosticHealth({collector,bypass:{state:'degraded',error:'controller_http_401',stage:'controller'}});
  assert.equal(value.collector.tone,'good');assert.equal(value.collector.title,'正在持续取证');
  assert.equal(value.bypass.tone,'bad');assert.match(value.bypass.detail,/401/);assert.equal(value.bypass.stage,'代理控制接口');
  assert.equal(diagnosticHealth({collector,bypass:{state:'verified',targets:5,verified:5,client:'flclash'}}).bypass.tone,'good');
  assert.match(diagnosticHealth({collector,bypass:{state:'checking',previousState:'degraded',error:'flclash_controller_disabled'}}).bypass.detail,/FlClash 未开启/);
  assert.equal(diagnosticHealth({collector,bypass:{state:'stale'}}).bypass.tone,'warn');
  assert.equal(diagnosticHealth({collector:{...collector,trace:'unavailable'}}).collector.tone,'warn');
  assert.equal(diagnosticHealth({liveAvailable:false,collector,bypass:{state:'verified'}}).bypass.tone,'neutral');
});
test('relay health reports actual failed evidence and keeps arbitrary error strings and configuration out of live status',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-relay-health-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const health=relayResultHealth({state:'degraded',at:10,targets:[{}],overlay:{client:'flclash'},checks:[{verified:false,seenInClash:null,probe:{phase:'tls',errorType:'Synthetic'},systemDnsMatches:false,routePhysical:true,sourceMatches:true}],errors:[],lastVerifiedAt:5});
  assert.deepEqual(health.failures.map(item=>item.code),['system_dns_mismatch','physical_probe_failed','clash_observation_unavailable']);
  assert.equal(health.lastVerifiedAt,5);assert.equal(relayErrorCode('controller_http_401'),'controller_http_401');
  assert.equal(relayErrorCode(new Error('https://private.example.test/?secret=synthetic')),'bypass_validation_failed');
  fs.mkdirSync(path.join(root,'relay-bypass'));fs.writeFileSync(path.join(root,'relay-bypass','status.json'),JSON.stringify({...health,at:10,secret:'private-canary',failures:[...health.failures,{code:'private-canary',count:1}]}));
  const result=readRelayHealth(root,20);assert.equal(JSON.stringify(result).includes('private-canary'),false);assert.equal(result.failures.length,3);
  assert.equal(readRelayHealth(root,200000).state,'stale');
});

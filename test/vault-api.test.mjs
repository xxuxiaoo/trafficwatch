import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createVaultKeys } from '../src/vault-crypto.mjs';
import { Store } from '../src/store.mjs';
import { startOverviewServer } from '../src/overview-server.mjs';

async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
test('HTTP routes enforce password, source scope, exact dates, notes privileges, lock policy and panic revocation',{timeout:30000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tw-vault-api-'));let app,notify;
  try{
    const {metadata}=await createVaultKeys('synthetic-only-password','synthetic-sid');
    for(const lane of ['windows','clash']){
      const store=new Store(path.join(dir,lane));
      for(const day of [10,11,12]){const at=Date.parse(`2026-11-${day}T12:00:00+08:00`);store.record({at,duration:1000,allUp:day,allDown:day*10,codexUp:0,codexDown:0,unknownUp:0,unknownDown:0,activeSessions:[],rows:[{key:'synthetic-'+day,host:`day-${day}.example.test`,process:'synthetic.exe',network:'tcp',pid:1,scope:'other',evidence:'etw',rule:'{}',up:day,down:day*10}]});}store.close();
    }
    fs.mkdirSync(path.join(dir,'vault'));fs.writeFileSync(path.join(dir,'vault','vault.json'),JSON.stringify(metadata));
    const port=await freePort();app=startOverviewServer({historyRoot:dir,listenPort:port,sourcePorts:[await freePort(),await freePort()],suiteSettings:{OwnerSid:'synthetic-sid',RelayHosts:['relay.example.test']},guardFactory:callback=>{notify=callback;return {start(){callback({state:'unlocked'});},close(){}};}});
    await new Promise(resolve=>app.server.listening?resolve():app.server.once('listening',resolve));
    const call=async(route,{body,token}={})=>{const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:body===undefined?'GET':'POST',headers:{'x-codex-flow':'1',...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
    const relayPage=await fetch(`http://127.0.0.1:${port}/relays`);assert.equal(relayPage.status,200);assert.match(await relayPage.text(),/中转直连/);
    assert.equal((await call('/api/overview?range=all')).status,423);
    const unlocked=await call('/api/vault/unlock',{body:{password:'synthetic-only-password'}});assert.equal(unlocked.status,200);const owner=unlocked.data.token;
    assert(unlocked.data.sessionExpiresAt>Date.now());assert.equal((await call('/api/vault/session',{token:owner})).data.owner,true);
    for(let attempt=0;attempt<80&&!app.vault.ready;attempt++)await new Promise(resolve=>setTimeout(resolve,50));assert.equal(app.vault.ready,true,JSON.stringify(app.vault.status()));
    app.vault.ready=false;
    try{
      assert.equal((await call('/api/overview?range=all',{token:owner})).status,503);
      const preparing=await call('/api/diagnostics',{token:owner});assert.equal(preparing.status,503);assert.equal(preparing.data.error,'vault_migrating');
      assert.equal((await call('/api/live',{token:owner})).status,200);
      assert.equal((await call('/api/diagnostics/status',{token:owner})).status,200);
      assert.equal((await call('/api/ai/session',{token:owner})).data.owner,true);
    }finally{app.vault.ready=true;}
    const relayList=await call('/api/relay-targets',{token:owner});assert.equal(relayList.status,200);assert.deepEqual(relayList.data.targets.map(target=>target.host),['relay.example.test']);
    assert.equal((await call('/api/relay-targets',{body:{action:'save',targets:[]}})).status,423,'relay configuration requires the unlocked owner');
    const relayUpdate=await call('/api/relay-targets',{token:owner,body:{action:'save',targets:[{id:'e01c8b46-1262-4f23-9c4d-647a4d5519ca',name:'new relay',host:'new-relay.example.test',enabled:true}]}});assert.equal(relayUpdate.status,200);assert.equal(relayUpdate.data.backups.length,1);
    const relayRead=await call('/api/relay-targets',{token:owner});assert.equal(relayRead.data.targets[0].host,'new-relay.example.test');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'relay-bypass','refresh.request'),'utf8')).at,relayUpdate.data.at);
    const conflict=await call('/api/relay-targets',{token:owner,body:{action:'save',targets:[],revision:relayList.data.revision}});assert.equal(conflict.status,400);assert.equal(conflict.data.error,'relay_config_conflict');
    const duplicate=await call('/api/relay-targets',{token:owner,body:{action:'save',targets:[...relayRead.data.targets,{name:'duplicate',host:'new-relay.example.test'}]}});assert.equal(duplicate.status,400);assert.equal(duplicate.data.error,'duplicate_relay_target');
    const initialBackup=relayUpdate.data.backups.find(item=>item.targets===1);assert(initialBackup);
    const disabledRelays=await call('/api/relay-targets',{token:owner,body:{action:'disable-all'}});assert.equal(disabledRelays.status,200);assert.equal(disabledRelays.data.targets[0].enabled,false);
    const restoredRelays=await call('/api/relay-targets',{token:owner,body:{action:'restore',id:initialBackup.id}});assert.equal(restoredRelays.status,200);assert.deepEqual(restoredRelays.data.targets.map(target=>target.host),['relay.example.test']);
    const request=(await call('/api/ai/request',{body:{name:'Synthetic test'}})).data;
    const grant={name:'test',lanes:['clash'],permissions:['read','create'],minutes:60,continueWhenLocked:true,scope:{kind:'dates',dates:['2026-11-10','2026-11-12']}};
    assert.equal((await call('/api/vault/grants',{token:owner,body:{requestId:request.id,grant}})).status,200);
    const claimed=(await call('/api/ai/claim',{body:request})).data;const token=claimed.token;
    assert.equal((await call('/api/relay-targets',{token})).status,423,'AI visitor cards cannot change network routing');
    assert.equal((await call('/api/vault/session',{token})).status,423,'AI credentials never restore the owner UI');
    const overview=await call('/api/overview?range=all',{token});assert.equal(overview.status,200);assert.equal(overview.data.clash.totals.up,22);assert.equal(overview.data.machine.available,false);
    assert.equal((await call('/api/detail?lane=windows&range=all',{token})).status,423);
    assert.equal((await call('/api/detail?lane=clash&range=all&export=1',{token})).status,423);
    const note={at:Date.parse('2026-11-10T12:00:00+08:00'),title:'test note',body:'synthetic'};
    assert.equal((await call('/api/ai/notes',{token,body:{action:'create',lane:'clash',note}})).status,200);
    assert.equal((await call('/api/ai/notes',{token,body:{action:'create',lane:'clash',note:{...note,at:Date.parse('2026-11-11T12:00:00+08:00')}}})).status,400);
    assert.equal((await call('/api/vault/cleanup',{token,body:{}})).status,423);
    assert.equal((await call('/api/vault/cleanup',{token:owner,body:{}})).status,202);
    await app.vault.cleanupPromise;
    assert.equal(app.vault.status().cleanup.state,'completed');
    assert.equal((await call('/api/vault/cleanup',{token:owner,body:{}})).status,200);
    assert.equal(fs.existsSync(path.join(dir,'windows','monitor.sqlite')),false);
    assert.equal(fs.existsSync(path.join(dir,'clash','monitor.sqlite')),false);
    assert.equal(app.vault.metadata.cleanupComplete,true);
    assert.equal((await call('/api/ai/delete-history',{token,body:{lane:'clash',windows:claimed.grant.windows}})).status,400);
    const deleted=[{from:Date.parse('2026-11-11T00:00:00+08:00'),to:Date.parse('2026-11-12T00:00:00+08:00')}];
    assert.equal((await call('/api/ai/delete-history',{token:owner,body:{lane:'clash',windows:deleted}})).status,200);
    const afterDeletion=await call('/api/overview?range=all&fresh=1',{token:owner});assert.equal(afterDeletion.data.clash.totals.up,22);
    notify({state:'locked'});assert.equal((await call('/api/overview?range=all',{token:owner})).status,423);
    assert.equal((await call('/api/vault/session',{token:owner})).status,423);
    assert.equal((await call('/api/detail?lane=clash&range=all',{token})).status,200);
    notify({state:'unlocked'});assert.equal((await call('/api/overview?range=all',{token:owner})).status,423);
    app.vault.lock({force:true});assert.equal((await call('/api/detail?lane=clash&range=all',{token})).status,423);
  }finally{app?.close();await new Promise(resolve=>setTimeout(resolve,100));fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

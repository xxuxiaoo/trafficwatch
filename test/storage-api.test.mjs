import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createVaultKeys} from '../src/vault-crypto.mjs';
import {Store} from '../src/store.mjs';
import {startOverviewServer} from '../src/overview-server.mjs';
const freePort=async()=>{const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;};
const at=day=>Date.parse(day+'T12:00:00+08:00');
test('storage jobs return promptly, preserve archived visitor scope, delete exact old dates and restart readers after reclamation',{timeout:30000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-storage-api-'));let app;
  try{
    const {metadata}=await createVaultKeys('synthetic-storage-password','synthetic-owner');
    for(const lane of ['windows','clash']){
      const store=new Store(path.join(root,lane));
      for(const day of ['2026-06-09','2026-06-10','2026-06-11','2026-11-14'])store.record({at:at(day),duration:1000,allUp:100,allDown:200,codexUp:100,codexDown:200,unknownUp:0,unknownDown:0,activeSessions:[],rows:[{key:'connection-'+day,host:day+'.example.test',network:'tcp',process:'codex.exe',pid:1,scope:'codex',evidence:'etw',rule:'{}',up:100,down:200}]});store.close();
    }
    fs.mkdirSync(path.join(root,'vault'));fs.writeFileSync(path.join(root,'vault','vault.json'),JSON.stringify(metadata));
    const port=await freePort();app=startOverviewServer({historyRoot:root,listenPort:port,sourcePorts:[await freePort(),await freePort()],suiteSettings:{OwnerSid:'synthetic-owner'},guardFactory:callback=>({start(){callback({state:'unlocked'});},close(){}})});
    await new Promise(r=>app.server.listening?r():app.server.once('listening',r));
    const call=async(route,{body,token}={})=>{const response=await fetch('http://127.0.0.1:'+port+route,{method:body===undefined?'GET':'POST',headers:{'x-codex-flow':'1',...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
    assert.equal((await call('/api/vault/storage')).status,423);
    const owner=(await call('/api/vault/unlock',{body:{password:'synthetic-storage-password'}})).data.token;
    for(let i=0;i<150&&!app.vault.ready;i++)await new Promise(r=>setTimeout(r,20));assert.ok(app.vault.ready);
    const request=(await call('/api/ai/request',{body:{name:'Synthetic archive reader'}})).data;
    await call('/api/vault/grants',{token:owner,body:{requestId:request.id,grant:{lanes:['clash'],permissions:['read','deleteHistory'],minutes:60,continueWhenLocked:true,scope:{kind:'dates',dates:['2026-06-09','2026-06-11']}}}});
    const visitor=(await call('/api/ai/claim',{body:request})).data.token;
    assert.equal((await call('/api/vault/storage',{token:visitor})).status,423);
    assert.equal((await call('/api/vault/storage/run',{token:visitor,body:{}})).status,423);
    const started=await call('/api/vault/storage/run',{token:owner,body:{}});assert.equal(started.status,202);await app.vault.storagePromise;
    let snapshot=(await call('/api/vault/storage?fresh=1',{token:owner})).data;
    assert.equal(snapshot.lanes[0].archives.rows,6);assert.equal(snapshot.detailsRetained,'forever');
    const overview=await call('/api/overview?range=all',{token:visitor});assert.equal(overview.data.clash.totals.up,200);assert.equal(overview.data.machine.available,false);
    const deleted=await call('/api/ai/delete-history',{token:visitor,body:{lane:'clash',windows:[{from:at('2026-06-09'),to:at('2026-06-10')+60000}]}});
    assert.equal(deleted.status,200,JSON.stringify(deleted));
    const detail=await call('/api/detail?lane=clash&range=all',{token:visitor});assert.equal(detail.data.summary.up,100);assert.equal(detail.data.connections[0].host,'2026-06-11.example.test');
    const ownerView=await call('/api/overview?range=all&fresh=1',{token:owner});assert.equal(ownerView.data.clash.totals.up,300,'middle unauthorized day must survive requested broad deletion');
    const compact=await call('/api/vault/storage/compact',{token:owner,body:{}});assert.equal(compact.status,202);await app.vault.storagePromise;
    snapshot=(await call('/api/vault/storage?fresh=1',{token:owner})).data;assert.equal(snapshot.job.state,'completed',JSON.stringify(snapshot.job));
    const after=await call('/api/detail?lane=clash&range=all',{token:visitor});assert.equal(after.status,200);assert.equal(after.data.summary.up,100);
    assert.equal((await call('/api/vault/storage/cache',{token:owner,body:{}})).status,202);await app.vault.storagePromise;
    assert.equal((await call('/api/overview?range=today',{token:owner})).status,200);
    app.vault.lock();assert.equal((await call('/api/vault/storage',{token:owner})).status,423);assert.equal((await call('/api/detail?lane=clash&range=all',{token:visitor})).data.summary.up,100);
  }finally{app?.close();await new Promise(r=>setTimeout(r,200));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

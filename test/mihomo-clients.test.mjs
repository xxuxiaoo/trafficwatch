import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chooseController,discoverEndpoints,requestSnapshot,requestController,MihomoSource,assertObservableClient} from '../src/mihomo.mjs';

test('an idle Mihomo null connection list is a valid snapshot with unchanged global counters',async t=>{
  const server=http.createServer((_req,res)=>res.end(JSON.stringify({connections:null,uploadTotal:12,downloadTotal:34})));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const candidate={endpoint:'127.0.0.1:'+server.address().port,secret:''};
  for(const snapshot of [await requestSnapshot(candidate),await requestController(candidate,'/connections')]){assert.deepEqual(snapshot.connections,[]);assert.equal(snapshot.uploadTotal,12);assert.equal(snapshot.downloadTotal,34);}
  const source=new MihomoSource({controller:candidate.endpoint,secret:''});await source.snapshot();assert.equal(source.generation,1);await source.snapshot();assert.equal(source.generation,1);
});
test('client selection follows the live TUN rather than a fixed port or an idle installed client',()=>{
  const verge={candidate:{client:'verge',endpoint:'verge-production'},config:{'mixed-port':8901,tun:{enable:false}}};
  const fl={candidate:{client:'flclash',endpoint:'127.0.0.1:9998'},config:{'mixed-port':8999,tun:{enable:true,device:'FlClash'}}};
  assert.equal(chooseController([verge,fl]),fl);assert.equal(chooseController([fl,verge]),fl);
  const sidecar={...verge,candidate:{...verge.candidate,endpoint:'\\\\.\\pipe\\verge-mihomo-sidecar-synthetic'},config:{...verge.config,tun:{enable:true}}};
  assert.equal(chooseController([sidecar,verge]),verge);
  assert.equal(chooseController([{...verge,config:{...verge.config,tun:{enable:true}}},{...fl,config:{...fl.config,tun:{enable:false}}}]).candidate.client,'verge');
  assert.throws(()=>chooseController([{...verge,config:{...verge.config,tun:{enable:true}}},fl]),/clash_multiple_active_tun/);
});
test('FlClash discovery uses its own local controller credentials and never inherits a Verge secret',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-proxy-clients-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'com.follow','clash');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'config.yaml'),'mixed-port: 8999\nexternal-controller: 127.0.0.1:9998\nsecret: synthetic-flclash-secret\ntun:\n  enable: true\n');
  const candidates=discoverEndpoints({controller:'auto',secret:'synthetic-verge-secret'},{APPDATA:root});
  const fl=candidates.find(item=>item.client==='flclash');assert(fl);assert.equal(fl.secret,'synthetic-flclash-secret');assert.equal(fl.configPath,path.join(dir,'config.yaml'));
  fs.writeFileSync(path.join(dir,'shared_preferences.json'),JSON.stringify({'flutter.config':JSON.stringify({patchClashConfig:{'external-controller':'127.0.0.1:9997',secret:'synthetic-rotated-secret'}})}));
  const rotated=discoverEndpoints({controller:'auto',secret:'synthetic-verge-secret'},{APPDATA:root}).find(item=>item.client==='flclash');
  assert.equal(rotated.endpoint,'127.0.0.1:9997');assert.equal(rotated.secret,'synthetic-rotated-secret');
  fs.unlinkSync(path.join(dir,'shared_preferences.json'));
  const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  fs.writeFileSync(path.join(dir,'config.yaml'),`mixed-port: ${server.address().port}\nexternal-controller: ''\ntun:\n  enable: true\n`);
  await assert.rejects(assertObservableClient([],{controller:'auto'},{APPDATA:root}),/flclash_controller_disabled/);
});

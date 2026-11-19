import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chooseController,discoverEndpoints,requestSnapshot,requestController,MihomoSource,assertObservableClient} from '../src/mihomo.mjs';
import {Accounting} from '../src/accounting.mjs';
import {airportIndex} from '../src/proxy-airports.mjs';

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
test('TUN switches and a stopped FlClash leave controller attribution independent of Windows route ownership',async t=>{
  const makeClient=(client,device)=>{
    const state={running:true,tun:client==='flclash',download:0};
    const server=http.createServer((req,res)=>{
      if(!state.running){res.writeHead(503);res.end();return;}
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(req.url==='/configs'?{'mixed-port':0,tun:{enable:state.tun,device}}:{
        connections:[{id:'same-id',start:'2026-11-19T00:00:00Z',upload:0,download:state.download,chains:['Synthetic node']}],
        uploadTotal:0,downloadTotal:state.download,
      }));
    });
    return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>{
      const endpoint=`127.0.0.1:${server.address().port}`;
      t.after(()=>new Promise(done=>server.close(()=>done())));
      resolve({state,candidate:{client,endpoint,secret:''}});
    }));
  };
  const verge=await makeClient('verge','Verge'),fl=await makeClient('flclash','FlClash');
  let now=Date.parse('2026-11-19T01:00:00Z'),outbound=3;
  const source=new MihomoSource({controller:'auto'}, {
    discover:()=>[verge.candidate,fl.candidate],assertObservable:async()=>{},now:()=>now,
    interfaceReader:async()=>({adapters:[{name:'Verge',status:'Up',ipv4:1},{name:'FlClash',status:'Up',ipv4:2}],routes:[{family:4,index:outbound}]}),
  });
  const accounting=new Accounting({preserveRouteMetadata:true});
  const sample=async()=>accounting.consume(await source.snapshot(),now+=5000,()=>null);
  await sample();
  assert.equal(source.status().routing,'none','FlClash can keep TUN enabled without taking the route');
  assert.equal(source.status().state,'idle');
  verge.state.tun=true;outbound=1;
  await sample();
  assert.equal(source.status().routeClient,'verge','Windows routes identify an idle active tunnel');
  verge.state.download=135;
  assert.equal((await sample()).allDown,135);
  verge.state.tun=false;outbound=2;
  verge.state.download+=17;fl.state.download=41;
  const cutover=await sample();
  assert.equal(cutover.allDown,58);
  assert.equal(source.status().routeClient,'flclash');
  assert.equal(source.status().state,'multiple');
  assert.deepEqual(cutover.rows.map(row=>[JSON.parse(row.rule).client,row.down]),[['verge',17],['flclash',41]]);
  assert.notEqual(cutover.rows[0].key,cutover.rows[1].key);
  fl.state.running=false;verge.state.download+=8;
  assert.equal((await sample()).allDown,8,'a missing FlClash controller must not drop observed Verge data');
  assert.equal(source.status().state,'partial');
  assert.equal(source.status().routeClient,'flclash');
  outbound=3;
  await sample();
  assert.equal(source.status().routing,'none');
  assert.equal(source.status().routeClient,null);
  assert.equal(source.status().clients.find(client=>client.client==='flclash').reachable,false);
  fl.state.running=true;fl.state.download=300;
  assert.equal((await sample()).allDown,0,'a restarted controller establishes a new baseline');
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

test('automatic airports use confirmed subscription membership and leave ambiguous duplicate names unlabelled',()=>{
  const proxies=(...names)=>names.map(name=>({name}));
  const inventory={providers:{
    default:{vehicleType:'Compatible',proxies:proxies('Inline','Shared')},
    Other:{vehicleType:'HTTP',proxies:proxies('Unique','Shared')},
    Distinct:{vehicleType:'File',proxies:proxies('Shared')},
  }};
  const lookup=airportIndex('verge',inventory,{id:'profile-id',name:'Synthetic airport',nodes:new Set(['Inline','Shared'])});
  assert.equal(lookup({chains:['Inline']}).name,'Synthetic airport');
  assert.equal(lookup({chains:['Unique']}).name,'Other');
  assert.equal(lookup({chains:['Shared']}),null);
  assert.equal(lookup({chains:['Shared'],providerChains:['Distinct']}).name,'Distinct');
  const stale=airportIndex('verge',inventory,{id:'another-profile',name:'New airport',nodes:new Set(['Inline','Not yet loaded'])});
  assert.equal(stale({chains:['Inline']}),null);
});

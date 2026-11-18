import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {parse,stringify} from 'yaml';
import {applyClashOverlay,patchProfileScript} from '../src/relay-clash-overlay.mjs';

test('FlClash overlays reload only its own runtime, retain live controller settings and restore exactly owned additions',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-flclash-overlay-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runtimeFile=path.join(root,'flclash','config.yaml'),vergeFile=path.join(root,'verge','clash-verge.yaml'),stateDir=path.join(root,'state');
  for(const dir of [path.dirname(runtimeFile),path.dirname(vergeFile),stateDir])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(vergeFile,'verge-synthetic-canary');
  const original={mode:'rule','mixed-port':8999,'external-controller':'',secret:'',dns:{'fake-ip-filter':['user.example.test']},tun:{enable:true,device:'FlClash','route-exclude-address':['192.0.2.0/24']},rules:['DOMAIN,api.example.test,Synthetic proxy','MATCH,Synthetic proxy'],proxies:[{name:'Synthetic proxy',type:'direct'}]};
  let effective=structuredClone(original),writes=0;
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/rules'){res.end(JSON.stringify({rules:effective.rules.filter(value=>value.startsWith('DOMAIN,')).map(value=>({type:'Domain',payload:value.split(',')[1],proxy:value.split(',')[2]}))}));return;}
    if(req.url==='/configs?force=false'&&req.method==='PUT'){
      let text='';for await(const part of req)text+=part;effective=parse(JSON.parse(text).payload);writes++;res.end('{}');return;
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  fs.writeFileSync(runtimeFile,stringify(original));
  const candidate={client:'flclash',configPath:runtimeFile,endpoint:'127.0.0.1:'+server.address().port,secret:'synthetic-live-controller-secret'},settings={OwnerProfile:root,ClashConfigPath:vergeFile};
  const controller=()=>({candidate,config:effective});
  const request={hosts:['api.example.test'],ips:['93.184.216.34'],stateDir};
  const applied=await applyClashOverlay(settings,{...request,controller:controller()});assert.equal(applied.client,'flclash');assert.equal(writes,1);
  assert.equal(effective['mixed-port'],8999);assert.equal(effective['external-controller'],candidate.endpoint);assert.equal(effective.secret,candidate.secret);
  assert.deepEqual(effective.proxies,original.proxies);assert.equal(fs.readFileSync(vergeFile,'utf8'),'verge-synthetic-canary');
  assert.deepEqual(effective.dns['fake-ip-filter'],['user.example.test','api.example.test']);assert.deepEqual(effective.tun['route-exclude-address'],['192.0.2.0/24','93.184.216.34/32']);
  assert.equal((await applyClashOverlay(settings,{...request,controller:controller()})).state,'unchanged');assert.equal(writes,1);
  await applyClashOverlay(settings,{...request,rollback:true,controller:controller()});
  assert.deepEqual(effective.rules,original.rules);assert.deepEqual(effective.dns,original.dns);assert.deepEqual(effective.tun,original.tun);
  assert.equal(fs.existsSync(path.join(stateDir,'clash-overlay.json')),false);assert.equal(fs.existsSync(path.join(stateDir,'clash-overlay-flclash.json')),true);
});

test('restoring the original path clears owned entries from both installed clients even when one is closed',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tw-proxy-restore-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const stateDir=path.join(root,'state'),vergeFile=path.join(root,'verge','clash-verge.yaml'),flFile=path.join(root,'AppData','Roaming','com.follow','clash','config.yaml'),script=path.join(path.dirname(vergeFile),'profiles','managed.js');
  for(const dir of [stateDir,path.dirname(vergeFile),path.dirname(flFile),path.dirname(script)])fs.mkdirSync(dir,{recursive:true});
  const original={dns:{'fake-ip-filter':['original.example.test']},tun:{enable:false,'route-exclude-address':['192.0.2.0/24']},rules:['MATCH,Synthetic proxy']};
  for(const [client,file]of [['verge',vergeFile],['flclash',flFile]]){
    const runtime=structuredClone(original);runtime.dns['fake-ip-filter'].push('relay.example.test');runtime.tun['route-exclude-address'].push('93.184.216.34/32');runtime.rules.unshift('DOMAIN,relay.example.test,DIRECT');fs.writeFileSync(file,stringify(runtime));
    fs.writeFileSync(path.join(stateDir,client==='verge'?'clash-overlay.json':'clash-overlay-flclash.json'),JSON.stringify({hosts:['relay.example.test'],ips:['93.184.216.34'],ruleOwnership:{'relay.example.test':{inserted:true}}}));
  }
  fs.writeFileSync(script,patchProfileScript('function main(config) { return config; }',['relay.example.test'],['93.184.216.34']));
  const result=await applyClashOverlay({OwnerProfile:root,ClashConfigPath:vergeFile,BypassProfileScript:script},{hosts:[],ips:[],rollback:true,stateDir,rollbackControllers:[]});
  assert.equal(result.clients.length,2);assert(result.clients.every(item=>!item.liveApplied));
  for(const file of [vergeFile,flFile])assert.deepEqual(parse(fs.readFileSync(file,'utf8')),original);
  assert.equal(fs.readFileSync(script,'utf8').includes('BEGIN TrafficWatch'),false);
});

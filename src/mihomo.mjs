import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {createRequire} from 'node:module';
import { yamlScalar } from './config.mjs';
import { inspectTunnelInterfaces } from './ai-windows.mjs';
import { airportIndex, airportProfileStamp, subscriptionFor } from './proxy-airports.mjs';

export function validateEndpoint(endpoint) {
  if (endpoint.startsWith('\\\\.\\pipe\\')) return { socketPath: endpoint };
  const url = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Controller must be a local HTTP endpoint or Windows named pipe');
  }
  return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || 80 };
}

export function discoverEndpoints(config, env = process.env) {
  if (config.controller !== 'auto') return [{ endpoint: config.controller, secret: config.secret }];
  const candidates = [];
  const suiteFile=config.root&&path.join(config.root,'suite-settings.json');
  let ownerProfile=config.ownerProfile;
  if(!ownerProfile&&suiteFile)try{ownerProfile=JSON.parse(fs.readFileSync(suiteFile,'utf8').replace(/^\uFEFF/,'')).OwnerProfile;}catch{}
  const appData=ownerProfile?path.join(ownerProfile,'AppData','Roaming'):env.APPDATA;
  const dirs = [
    appData && path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev'),
    appData && path.join(appData, 'io.github.clash-verge.clash-verge'),
    path.join(os.homedir(), '.config', 'clash-verge'),
  ].filter(Boolean);
  for (const dir of dirs)
    for (const file of ['clash-verge.yaml', 'config.yaml']) {
      try {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        const secret = yamlScalar(text, 'secret') || config.secret || '';
        const pipe = yamlScalar(text, 'external-controller-pipe');
        const tcp = yamlScalar(text, 'external-controller');
        const metadata={client:'verge',configPath:path.join(dir,'clash-verge.yaml')};
        if (pipe) candidates.push({ endpoint: pipe, secret,...metadata });
        if (tcp) candidates.push({ endpoint: tcp.replace('0.0.0.0', '127.0.0.1'), secret,...metadata });
      } catch {
        /* Other clients may not be installed. */
      }
    }
  if (process.platform === 'win32') {
    try {
      for (const name of fs.readdirSync('\\\\.\\pipe\\')) {
        if (/^(verge-mihomo-(production|sidecar)|mihomo$|clash$)/i.test(name))
          candidates.push({ endpoint: `\\\\.\\pipe\\${name}`, secret:candidates.find(candidate=>candidate.client==='verge')?.secret||config.secret||'',client:/^verge-/i.test(name)?'verge':'mihomo',configPath:candidates.find(candidate=>candidate.client==='verge')?.configPath });
      }
    } catch {
      /* Enumeration may be restricted; configured paths still work. */
    }
  }
  if(appData){
    const configPath=path.join(appData,'com.follow','clash','config.yaml');
    try{
      const fl=flClashConfig(config,env),values=fl.config,secret=values.secret||'';
      for(const key of ['external-controller-pipe','external-controller']){
        const endpoint=values[key];
        if(endpoint)candidates.push({endpoint:endpoint.replace('0.0.0.0','127.0.0.1'),secret,client:'flclash',configPath});
      }
    }catch{}
  }
  candidates.push({ endpoint: '127.0.0.1:9090', secret: config.secret });
  return candidates.filter((v, i, a) => a.findIndex((x) => x.endpoint === v.endpoint) === i);
}

export function normalizeSnapshot(data){
  if(!data||(!Array.isArray(data.connections)&&data.connections!==null)||!Number.isFinite(data.uploadTotal)||!Number.isFinite(data.downloadTotal))throw new Error('Unexpected Mihomo response');
  return {...data,connections:data.connections||[]};
}

const adapterName = value => String(value || '').trim().toLowerCase();
const knownDevices = { verge: ['clash verge', 'clashverge', 'verge-mihomo', 'mihomo'], flclash: ['flclash'] };

export function tunnelStatus(client, device, network) {
  const { adapters, routes } = network || {};
  const names = device ? [adapterName(device)] : knownDevices[client] || [];
  const matched = adapters?.filter(adapter => names.includes(adapterName(adapter.name))) || [];
  if (matched.length !== 1) return { interfaceStatus: adapters && !matched.length ? 'missing' : 'unknown', route: null };
  const adapter = matched[0];
  const up = adapter.status === 'Up';
  const routed = up && routes?.some(({ family, index }) => index === (family === 4 ? adapter.ipv4 : adapter.ipv6));
  return { interfaceStatus: up ? 'up' : 'down', interfaceName: adapter.name, route: routes?.length ? Boolean(routed) : null };
}

const isSidecar=item=>/[\\/]verge-mihomo-sidecar(?:-|$)/i.test(item.candidate.endpoint||'');
const controllerKey=item=>[item.candidate.client||'mihomo',item.config['mixed-port']||'',item.config.tun?.device||''].join('\u0000');
const captureKey = item => `${item.candidate.client || 'mihomo'}\0${item.candidate.endpoint}`;
function uniqueControllers(controllers){
  const running=controllers.filter(item=>!isSidecar(item));
  running.sort((a,b)=>Number(!/verge-mihomo-production-/i.test(a.candidate.endpoint||''))-Number(!/verge-mihomo-production-/i.test(b.candidate.endpoint||'')));
  return running.filter((item,index,all)=>all.findIndex(other=>controllerKey(other)===controllerKey(item))===index);
}
function summarizeClientEndpoints(outcomes){
  const clients=new Map();
  for(const result of outcomes){
    const client=result.candidate?.client||'mihomo',reachable=result.status==='fulfilled',previous=clients.get(client);
    if(!previous||reachable&&!previous.reachable)clients.set(client,{client,reachable,tunEnabled:reachable?result.value?.config?.tun?.enable===true:null});
    else if(reachable&&previous.reachable)previous.tunEnabled||=result.value?.config?.tun?.enable===true;
  }
  return [...clients.values()];
}

export function requestController(candidate,route,method='GET',body,{timeoutMs=1800}={}){
  return new Promise((resolve,reject)=>{
    let timer,finished=false;
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const req=http.request({...validateEndpoint(candidate.endpoint),path:route,method,headers:{...(candidate.secret?{Authorization:`Bearer ${candidate.secret}`}:{ }),...(body===undefined?{}:{'content-type':'application/json'})}},res=>{
      const chunks=[];let size=0;res.on('data',part=>{size+=part.length;if(size>16*1024*1024)res.destroy(new Error('controller_oversize'));else chunks.push(part);});res.on('error',error=>finish(error));
      res.on('end',()=>{if(res.statusCode<200||res.statusCode>=300)return finish(new Error('controller_http_'+res.statusCode));try{let value=size?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};if(route==='/connections')value=normalizeSnapshot(value);finish(null,value);}catch{finish(new Error('controller_invalid'));}});
    });
    timer=setTimeout(()=>req.destroy(new Error('controller_timeout')),timeoutMs);req.on('error',error=>finish(error));req.end(body===undefined?undefined:JSON.stringify(body));
  });
}

export function chooseController(controllers){
  // This controller-only selector is for configuration operations; capture uses
  // live traffic deltas. Never guess when more than one client has TUN enabled.
  const unique=uniqueControllers(controllers);
  const tun=unique.filter(item=>item.config.tun?.enable);
  if(tun.length>1)throw new Error('clash_multiple_active_tun');
  return tun[0]||unique[0]||null;
}

export function flClashConfig(config={},env=process.env){
  let ownerProfile=config.ownerProfile;
  if(!ownerProfile&&config.root)try{ownerProfile=JSON.parse(fs.readFileSync(path.join(config.root,'suite-settings.json'),'utf8').replace(/^\uFEFF/,'')).OwnerProfile;}catch{}
  const appData=ownerProfile?path.join(ownerProfile,'AppData','Roaming'):env.APPDATA;
  if(!appData)return null;
  const configPath=path.join(appData,'com.follow','clash','config.yaml');
  try{
    const text=fs.readFileSync(configPath,'utf8');
    const {parse}=createRequire(import.meta.url)('yaml'),current=parse(text);
    // FlClash updates the controller live without rewriting config.yaml. Its
    // preferences contain the current endpoint and rotated authentication key.
    try{const prefs=JSON.parse(fs.readFileSync(path.join(path.dirname(configPath),'shared_preferences.json'),'utf8')),patch=JSON.parse(prefs['flutter.config']).patchClashConfig;
      for(const key of ['external-controller','secret'])if(typeof patch?.[key]==='string')current[key]=patch[key];
    }catch{}
    return {configPath,config:current};
  }catch{return null;}
}
async function listening(port){
  if(!Number.isInteger(port)||port<1024||port>65535)return false;
  return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});let done=false;const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};socket.setTimeout(400,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));});
}
export async function assertObservableClient(controllers,config={},env=process.env){
  if(config.controller&&config.controller!=='auto')return;
  const fl=flClashConfig(config,env);
  if(fl?.config?.tun?.enable&&!controllers.some(item=>item.candidate.client==='flclash'&&item.config.tun?.enable)&&await listening(fl.config['mixed-port']))throw new Error(fl.config['external-controller']||fl.config['external-controller-pipe']?'flclash_controller_unavailable':'flclash_controller_disabled');
}
export async function discoverControllers(config,env=process.env){
  const outcomes=await Promise.allSettled(discoverEndpoints(config,env).map(async candidate=>({candidate,config:await requestController(candidate,'/configs')})));
  const controllers=outcomes.filter(result=>result.status==='fulfilled').map(result=>result.value);
  await assertObservableClient(controllers,config,env);
  return {controllers,outcomes};
}

export function requestSnapshot(candidate, timeoutMs = 1800) {
  const target = validateEndpoint(candidate.endpoint);
  return new Promise((resolve, reject) => {
    let deadline;
    const finish = (error, data) => {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(data);
    };
    const req = http.get(
      {
        ...target,
        path: '/connections',
        headers: candidate.secret ? { Authorization: `Bearer ${candidate.secret}` } : {},
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let size = 0;
        const parts = [];
        res.on('data', (part) => {
          size += part.length;
          if (size > 16 * 1024 * 1024) {
            res.destroy(new Error('Response too large'));
            return;
          }
          parts.push(part);
        });
        res.on('error', finish);
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
            finish(null, normalizeSnapshot(data));
          } catch (error) {
            finish(error);
          }
        });
      },
    );
    deadline = setTimeout(() => req.destroy(new Error('Controller timeout')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('Controller timeout')));
    req.on('error', finish);
  });
}

const counterValue=value=>Number.isFinite(value)&&value>=0?Math.floor(value):0;

export class MihomoSource {
  constructor(config,{discover=discoverEndpoints,controllerRequest=requestController,snapshotRequest=requestSnapshot,assertObservable=assertObservableClient,interfaceReader=inspectTunnelInterfaces,now=Date.now}={}) {
    this.config=config;this.current=null;this.endpoint='';this.generation=0;this.issue=null;
    this.counters=new Map();this.devices=new Map();this.interfaceReader=interfaceReader;this.now=now;
    this.airports=new Map();
    this.network=null;this.nextInterfaceCheck=0;this.selectedIdentity='';this.selection={state:'starting',client:null,clients:[]};
    this.discover=discover;this.controllerRequest=controllerRequest;this.snapshotRequest=snapshotRequest;this.assertObservable=assertObservable;
  }
  refreshInterfaces() {
    const now=this.now();
    if (this.interfaceCheck || now<this.nextInterfaceCheck) return;
    this.nextInterfaceCheck=now+4000;
    this.interfaceCheck=Promise.resolve().then(()=>this.interfaceReader()).then(result=>{
      this.network=result;
      this.networkAt=this.now();
    }).catch(()=>{this.network=null;}).finally(()=>{this.interfaceCheck=null;});
  }
  observe(item, now, nextCounters) {
    const key=captureKey(item),old=this.counters.get(key);
    const upload=counterValue(item.data.uploadTotal),download=counterValue(item.data.downloadTotal);
    const reset=!old||upload<old.upload||download<old.download;
    const delta=reset?0:upload-old.upload+download-old.download;
    const lastTrafficAt=delta?now:reset?null:old.lastTrafficAt;
    nextCounters.set(key,{upload,download,lastTrafficAt});
    return { key, reset, deltaBytes:delta, lastTrafficAt };
  }
  labelAirports({candidate, data}, key, now) {
    const stamp=airportProfileStamp(candidate);
    let entry=this.airports.get(key);
    if(!entry||entry.stamp!==stamp){
      entry={stamp,nextCheck:0};
      this.airports.set(key,entry);
    }
    if(!entry.pending&&now>=entry.nextCheck){
      entry.nextCheck=now+30000;
      entry.pending=Promise.resolve().then(()=>this.controllerRequest(candidate,'/providers/proxies'))
        .then(response=>{entry.lookup=airportIndex(candidate.client||'mihomo',response,subscriptionFor(candidate));})
        .catch(()=>{entry.lookup=null;}).finally(()=>{entry.pending=null;});
    }
    if(!entry.lookup)return data;
    const connections=data.connections.map(connection=>{
      const label=entry.lookup(connection);
      return label?{...connection,airport:label}:connection;
    });
    return {...data,connections};
  }
  activate(item,state,clients){
    const identity=controllerKey(item),endpoint=item.candidate.endpoint;
    if(this.selectedIdentity!==identity||this.current?.endpoint!==endpoint){this.generation++;this.selectedIdentity=identity;}
    this.current=item.candidate;this.endpoint=endpoint.startsWith('\\\\')?'Windows 命名管道':endpoint;
    this.selection={state,client:item.candidate.client||'mihomo',observedAt:this.now(),clients};this.issue=null;
    return {...item.data,proxyClient:item.candidate.client||'mihomo'};
  }
  async autoSnapshot(){
    this.refreshInterfaces();
    if(!this.candidates||this.now()>=this.rediscoverAt){
      this.candidates=this.discover(this.config);
      this.rediscoverAt=this.now()+4000;
    }
    const candidates=this.candidates;
    const settled=await Promise.allSettled(candidates.map(async candidate=>{
      const [config,data]=await Promise.all([this.controllerRequest(candidate,'/configs'),this.snapshotRequest(candidate)]);
      // A TCP fallback may use the same port as a stale configuration for another client.
      if(!candidate.endpoint.startsWith('\\\\')&&adapterName(config.tun?.device)==='flclash')candidate={...candidate,client:'flclash'};
      return {candidate,config,data};
    }));
    const outcomes=settled.map((result,index)=>({...result,candidate:result.value?.candidate||candidates[index]}));
    const controllers=outcomes.filter(result=>result.status==='fulfilled').map(result=>result.value);
    const unique=uniqueControllers(controllers);
    let controllerIssue=null;
    if(!unique.some(item=>item.candidate.client==='flclash')){
      try{await this.assertObservable(controllers,this.config);}catch(error){controllerIssue=error.message;}
    }
    const now=this.now(),network=now-this.networkAt<=7000?this.network:null;
    const clients=new Map(summarizeClientEndpoints(outcomes.filter(item=>!isSidecar(item))).map(item=>[item.client,item]));
    const nextCounters=new Map();
    const proxySnapshots=unique.map(item=>{
      const client=item.candidate.client||'mihomo',device=item.config.tun?.device;
      if(device)this.devices.set(client,device);
      const data=this.observe(item,now,nextCounters);
      const summary=clients.get(client);
      summary.deltaBytes=(summary.deltaBytes||0)+data.deltaBytes;
      summary.lastTrafficAt=Math.max(summary.lastTrafficAt||0,data.lastTrafficAt||0)||null;
      const snapshot=this.labelAirports(item,data.key,now);
      return {...snapshot,proxyClient:client,sourceKey:data.key,reset:data.reset};
    });
    this.counters=nextCounters;
    for (const key of this.airports.keys()) if (!nextCounters.has(key)) this.airports.delete(key);
    // Device matches and route checks diagnose TUN ownership, independently of
    // any clients using explicit proxy ports or closing connections at cutover.
    for(const client of ['verge','flclash']){
      if(!clients.has(client)&&(this.devices.has(client)||tunnelStatus(client,null,network).interfaceStatus==='up'))
        clients.set(client,{client,reachable:false,tunEnabled:null});
    }
    for(const item of clients.values()){
      Object.assign(item,tunnelStatus(item.client,this.devices.get(item.client),network));
      if(item.tunEnabled===false)item.route=false;
    }
    const routed=[...clients.values()].filter(item=>item.route===true);
    const active=[...clients.values()].filter(item=>item.deltaBytes>0);
    const routeClient=routed.length===1?routed[0].client:null;
    const routing=routed.length>1?'multiple':routeClient?'routed':!network?.routes?.length||[...clients.values()].some(item=>item.tunEnabled===true&&item.route===null)?'unknown':'none';
    const incomplete=routed.some(item=>!item.reachable)||Boolean(controllerIssue&&routing==='unknown');
    const client=active.length===1?active[0].client:null;
    const state=incomplete?'partial':active.length>1?'multiple':client?'active':unique.length?'idle':routing==='none'?'idle':'unavailable';
    this.selection={state,client,routeClient,routing,observedAt:now,clients:[...clients.values()]};
    this.issue=incomplete?'active_controller_unavailable':null;
    const current=unique.find(item=>item.candidate.client===(routeClient||client))||unique[0];
    this.current=current?.candidate||null;
    this.endpoint=this.current?.endpoint?.startsWith('\\\\')?'Windows 命名管道':this.current?.endpoint||'';
    if(!unique.length&&(routing!=='none'||incomplete)){
      const unauthorized=outcomes.some(result=>/HTTP (401|403)|controller_http_(401|403)/i.test(result.reason?.message||''));
      const incompatible=outcomes.some(result=>/HTTP |controller_http_|Unexpected Mihomo|JSON|Response too large/i.test(result.reason?.message||'')||result.reason instanceof SyntaxError);
      this.issue||=unauthorized?'authorization':incompatible?'incompatible':'unreachable';
      throw new Error(unauthorized?'接口需要授权：设置 MIHOMO_SECRET 后重启。':incompatible?'Mihomo 控制器响应格式不兼容。':'未连接 Mihomo：请启动代理，或在 config.local.json 配置本地 controller。');
    }
    if(!this.generation)this.generation=1;
    return {proxySnapshots,proxyClient:routeClient||client,proxyPartial:incomplete};
  }
  manualSelection(data){
    const client=this.current?.client||'mihomo',key=`manual\u0000${this.current?.endpoint||''}`,upload=counterValue(data.uploadTotal),download=counterValue(data.downloadTotal),old=this.counters.get(key);
    const delta=old&&upload>=old.upload&&download>=old.download?(upload-old.upload)+(download-old.download):0;
    this.counters.set(key,{upload,download});
    const state=delta?'active':old?'idle':'ready';
    const clients=[{client,reachable:true,tunEnabled:null,deltaBytes:delta,...(delta?{lastTrafficAt:Date.now()}:{})}];
    this.selection={state,client,observedAt:Date.now(),clients};
    return {...data,proxyClient:client};
  }
  async snapshot() {
    if(this.config.controller==='auto')return this.autoSnapshot();
    if(this.current){
      try{const data=await this.snapshotRequest(this.current);this.issue=null;return this.manualSelection(data);}
      catch{this.current=null;}
    }
    const candidates=this.discover(this.config),outcomes=await Promise.allSettled(candidates.map(async candidate=>({candidate,data:await this.snapshotRequest(candidate),config:{}})));
    const controllers=outcomes.filter(result=>result.status==='fulfilled').map(result=>result.value),found=controllers[0];
    if(!found){
      const unauthorized=outcomes.some(result=>/HTTP (401|403)/.test(result.reason?.message||''));
      this.issue=unauthorized?'authorization':outcomes.some(result=>/HTTP |Unexpected Mihomo|JSON|Response too large/i.test(result.reason?.message||'')||result.reason instanceof SyntaxError)?'incompatible':'unreachable';
      this.selection={state:'unavailable',client:null,observedAt:Date.now(),clients:[]};
      throw new Error(unauthorized?'接口需要授权：设置 MIHOMO_SECRET 后重启。':'未连接 Mihomo：请启动代理，或在 config.local.json 配置本地 controller。');
    }
    this.current=found.candidate;
    return this.activate(found,'ready',[{client:found.candidate.client||'mihomo',reachable:true,tunEnabled:null,deltaBytes:0}]);
  }
  status(){return {...this.selection,issue:this.issue};}
}

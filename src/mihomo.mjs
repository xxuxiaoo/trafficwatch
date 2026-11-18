import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {createRequire} from 'node:module';
import { yamlScalar } from './config.mjs';

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
  // Multiple installed clients are common. A live TUN wins over an idle core;
  // never use its port number as a client identity or load another client's YAML.
  const running=controllers.filter(item=>!/[\\/]verge-mihomo-sidecar-/i.test(item.candidate.endpoint||''));
  running.sort((a,b)=>Number(!/verge-mihomo-production-/i.test(a.candidate.endpoint||''))-Number(!/verge-mihomo-production-/i.test(b.candidate.endpoint||'')));
  const unique=running.filter((item,index,all)=>all.findIndex(other=>other.candidate.client===item.candidate.client&&other.config['mixed-port']===item.config['mixed-port']&&other.config.tun?.device===item.config.tun?.device)===index);
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

export class MihomoSource {
  constructor(config) {
    this.config = config;
    this.current = null;
    this.endpoint = '';
    this.generation = 0;
    this.issue = null;
    this.nextDiscovery=0;
  }
  async snapshot() {
    if (this.current && (this.config.controller!=='auto'||Date.now()<this.nextDiscovery)) {
      try {
        const data = await requestSnapshot(this.current);
        this.issue = null;
        return {...data,proxyClient:this.current.client||'mihomo'};
      } catch {
        this.current = null;
      }
    }
    const candidates = discoverEndpoints(this.config);
    const outcomes = await Promise.allSettled(
      candidates.map(async (c) => ({ candidate: c, data: await requestSnapshot(c),config:this.config.controller==='auto'?await requestController(c,'/configs'):{} })),
    );
    const controllers=outcomes.filter(result=>result.status==='fulfilled').map(result=>result.value);
    try{await assertObservableClient(controllers,this.config);}catch(error){this.current=null;this.issue='unreachable';throw error;}
    const selected=this.config.controller==='auto'?chooseController(controllers):controllers[0];
    const found=selected?{value:selected}:null;
    if (!found) {
      const unauthorized = outcomes.some((x) => /HTTP (401|403)/.test(x.reason?.message || ''));
      this.issue = unauthorized
        ? 'authorization'
        : outcomes.some(
              (x) =>
                /HTTP |Unexpected Mihomo|JSON|Response too large/i.test(x.reason?.message || '') ||
                x.reason instanceof SyntaxError,
            )
          ? 'incompatible'
          : 'unreachable';
      throw new Error(
        unauthorized
          ? '接口需要授权：设置 MIHOMO_SECRET 后重启。'
          : '未连接 Mihomo：请启动代理，或在 config.local.json 配置本地 controller。',
      );
    }
    this.issue = null;
    if(this.current?.endpoint!==found.value.candidate.endpoint||this.current?.client!==found.value.candidate.client)this.generation++;
    this.current = found.value.candidate;
    this.nextDiscovery=Date.now()+10000;
    this.endpoint = this.current.endpoint.startsWith('\\\\')
      ? 'Windows 命名管道'
      : this.current.endpoint;
    return {...found.value.data,proxyClient:this.current.client||'mihomo'};
  }
}

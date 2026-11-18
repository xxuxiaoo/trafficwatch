import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { HistoryReader } from './history-reader.mjs';
import { DEFAULT_CODEX_PROCESS_NAMES, normalizeHarnessApps } from './harness.mjs';
import { VaultService } from './vault-service.mjs';
import { vaultRoute } from './vault-router.mjs';
import { signCommand } from './vault-commands.mjs';
import { csvCell } from './server.mjs';
import { VERSION } from './version.mjs';
import { diagnosticRoute } from './ai-diagnostic-router.mjs';
import {readRelayTargetConfig,listRelayTargetBackups,saveRelayTargets,restoreRelayTargets,requestRelayReconcile,relayHostRevision} from './relay-targets.mjs';
import {BackgroundHistoryRefreshes} from './history-background-refresh.mjs';
import {normalizeAirportGroups} from './airport-groups.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function startOverviewServer({guardFactory,listenPort,suiteSettings,historyRoot,sourcePorts,readerFactory=(data,options)=>new HistoryReader(data,options)}={}){
const settingsPath = path.join(root, 'suite-settings.json');
const settings = suiteSettings||(fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''))
  : {});
const dataRoot = path.resolve(historyRoot||process.env.TRAFFICWATCH_DATA_ROOT || settings.DataRoot || path.join(root, 'data'));
const port = Number(listenPort||process.env.TRAFFICWATCH_OVERVIEW_PORT || 43131);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid overview port');
const host = `127.0.0.1:${port}`;
const collectorPorts=sourcePorts||[Number(process.env.TRAFFICWATCH_MACHINE_PORT||43128),Number(process.env.TRAFFICWATCH_CLASH_PORT||43130)];
if(collectorPorts.some(value=>!Number.isInteger(value)||value<1024||value>65535))throw new Error('Invalid collector port');
const cacheRoot = process.env.TRAFFICWATCH_CACHE_ROOT || path.join(dataRoot, 'viewer-cache');
const encryptedCacheRoot=path.join(cacheRoot,'encrypted-v1');
function queueRelayReconcile(){
  const config=readRelayTargetConfig(dataRoot,settings.RelayHosts);
  if(config.targets.some(target=>target.enabled))try{fs.unlinkSync(path.join(dataRoot,'relay-bypass','disabled'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return requestRelayReconcile(dataRoot);
}
const makeReader=(role,keyEntries)=>readerFactory({dataRoot,...(role==='history'?{cacheRoot:keyEntries?encryptedCacheRoot:cacheRoot}:{}),...(keyEntries?{keyEntries}:{})},{timeoutMs:role==='quick'?12000:role==='detail'?20000:45000},role);
let fullReader=makeReader('history'),quickReader=makeReader('quick'),detailReader=makeReader('detail');
const cache = new Map(), backgroundRefreshes = new BackgroundHistoryRefreshes();
let appsCache = null, appsPending = null, liveCache = null, livePending = null,cacheGeneration=0;
const clearCache=()=>{cacheGeneration++;cache.clear();backgroundRefreshes.cancelAll();appsCache=appsPending=liveCache=livePending=null;};
const vault=new VaultService({dataRoot,cacheRoot:encryptedCacheRoot,ownerSid:settings.OwnerSid,guardFactory,onLock:clearCache,onKeys:entries=>{
  fullReader.close();quickReader.close();detailReader.close();clearCache();
  fullReader=makeReader('history',entries);quickReader=makeReader('quick',entries);detailReader=makeReader('detail',entries);
},onMaintenance:async active=>{
  if(active){await Promise.all([fullReader.close(),quickReader.close(),detailReader.close()]);clearCache();}
  else{
    fullReader=makeReader('history',vault.keyEntries);quickReader=makeReader('quick',vault.keyEntries);detailReader=makeReader('detail',vault.keyEntries);clearCache();
  }
},waitForCollectors:async()=>{
  for(let attempt=0;attempt<20;attempt++){
    const states=await Promise.all(collectorPorts.map(async collectorPort=>{
      try{const response=await fetch(`http://127.0.0.1:${collectorPort}/api/health`,{signal:AbortSignal.timeout(700)});const state=await response.json();return state.app==='codex-flow'?state.sealedStorage===true:false;}catch{return true;}
    }));
    if(states.every(Boolean))return;await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('vault_collectors_need_update');
}});
function storeCache(key, data) {
  cache.delete(key); cache.set(key, { at: Date.now(), data, size: JSON.stringify(data).length });
  let size = [...cache.values()].reduce((n,item) => n+item.size,0);
  while (cache.size > 24 || size > 8000000) { const oldest = cache.keys().next().value; size -= cache.get(oldest).size; cache.delete(oldest); }
}
async function query(payload, { signal, quick = false, fresh = false } = {}) {
  const key = JSON.stringify([payload, new Date(Date.now()+8*3600000).toISOString().slice(0,10)]);
  const entry = cache.get(key), ttl = quick ? 10000 : payload.type === 'detail' ? 30000 : 60000;
  const reader = quick ? quickReader : ['detail','harness','ladder','ladder-nodes'].includes(payload.type)?detailReader:fullReader,currentGeneration=cacheGeneration;
  if(signal)backgroundRefreshes.cancel(reader,key);
  const load = async (signal) => {
    const result = await reader.query(payload, { signal });
    const data = { ...result, generatedAt: Date.now() };
    // An unreadable lane must not evict a previous good snapshot.
    if (currentGeneration===cacheGeneration&&(!data.machine || data.machine.available || data.clash?.available)) storeCache(key,data);
    return data;
  };
  if (entry && !fresh) {
    cache.delete(key); cache.set(key,entry);
    if (Date.now()-entry.at >= ttl && !backgroundRefreshes.has(reader,key)) {
      backgroundRefreshes.start(reader,key,signal=>load(signal));
    }
    return { ...entry.data, refreshing: Date.now()-entry.at >= ttl };
  }
  return load(signal);
}

async function live(collectorPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${collectorPort}/api/overview-live`, {
      headers: { 'x-codex-flow': '1' }, signal: AbortSignal.timeout(900),
    });
    if (!response.ok) return null;
    const data = vault.decryptLive(await response.json());
    return data.app === 'trafficwatch-live' ? data : null;
  } catch { return null; }
}

async function harnessApps() {
  if (appsCache && Date.now() - appsCache.at < 5000) return appsCache.apps;
  if (appsPending) return appsPending;
  appsPending = loadHarnessApps().finally(()=>{appsPending=null;}); return appsPending;
}
async function loadHarnessApps() {
  if(vault.configured){
    const saved=await quickReader.query({type:'apps'});appsCache={at:Date.now(),apps:saved.apps};return saved.apps;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${collectorPorts[0]}/api/harness-apps`, {
      headers: { 'x-codex-flow': '1' }, signal: AbortSignal.timeout(1200),
    });
    if (response.ok) {
      const data = await response.json();
      const apps = normalizeHarnessApps(data.apps, data.apps?.codex || DEFAULT_CODEX_PROCESS_NAMES);
      appsCache = { at: Date.now(), apps };
      return apps;
    }
  } catch { /* Use the built-in exact process names while collectors are offline. */ }
  try {
    const saved = await quickReader.query({ type: 'apps' });
    appsCache = { at: Date.now(), apps: saved.apps };
    return saved.apps;
  } catch { return normalizeHarnessApps(null, DEFAULT_CODEX_PROCESS_NAMES); }
}
async function livePacket() {
  if (liveCache && Date.now()-liveCache.at < 1500) return liveCache.value;
  if (!livePending) livePending = Promise.all(collectorPorts.map(live)).then(([machine,clash])=>{
    const value = { live: { machine,clash },generatedAt:Date.now() }; liveCache = { at:Date.now(),value }; return value;
  }).finally(()=>{livePending=null;});
  return livePending;
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.resume();
        reject(new Error('body_too_large'));
      } else chunks.push(chunk);
    });
    req.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid_json')); }
    });
    req.once('error', reject);
  });
}

async function updateHarnessApps(apps) {
  const current = await harnessApps();
  const normalized = normalizeHarnessApps(apps, current.codex);
  const previous = vault.configured?[current,current]:await Promise.all(collectorPorts.map(async (collectorPort) => {
    const response = await fetch(`http://127.0.0.1:${collectorPort}/api/harness-apps`, {
      headers: { 'x-codex-flow': '1' }, signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Both collectors must be connected to save Harness rules');
    return (await response.json()).apps;
  }));
  const changed = [];
  try {
    for (const [index, collectorPort] of collectorPorts.entries()) {
      const response = await fetch(`http://127.0.0.1:${collectorPort}/api/harness-apps`, {
        method: 'POST',
        headers: { 'x-codex-flow': '1', 'content-type': 'application/json',...(vault.configured?{'x-trafficwatch-command':signCommand('/api/harness-apps',{apps:normalized},vault.secrets)}:{}) },
        body: JSON.stringify({ apps: normalized }),
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) throw new Error('Harness rules could not be saved on both collectors');
      changed.push(index);
    }
  } catch (error) {
    let recovered = true;
    for (const index of changed) {
      try {
        const response = await fetch(`http://127.0.0.1:${collectorPorts[index]}/api/harness-apps`, {
          method: 'POST', headers: { 'x-codex-flow': '1', 'content-type': 'application/json',...(vault.configured?{'x-trafficwatch-command':signCommand('/api/harness-apps',{apps:previous[index]},vault.secrets)}:{}) },
          body: JSON.stringify({ apps: previous[index] }), signal: AbortSignal.timeout(2500),
        });
        recovered &&= response.ok;
      } catch { recovered = false; }
    }
    throw new Error(recovered ? '两路规则未保存，已保留原配置。请检查采集连接后重试。' : '两路规则可能不一致，请恢复采集后重新保存规则。');
  }
  appsCache = { at: Date.now(), apps: normalized };
  cache.clear();
  return normalized;
}

const assets = new Map([
  ['/', ['overview.html', 'text/html; charset=utf-8']],
  ['/overview', ['overview.html', 'text/html; charset=utf-8']],
  ['/overview.css', ['overview.css', 'text/css; charset=utf-8']],
  ['/overview.js', ['overview.js', 'text/javascript; charset=utf-8']],
  ['/history-progress.mjs', ['history-progress.mjs', 'text/javascript; charset=utf-8']],
  ['/security', ['vault.html','text/html; charset=utf-8']],
  ['/vault.js', ['vault.js','text/javascript; charset=utf-8']],
  ['/vault-browser.mjs', ['vault-browser.mjs','text/javascript; charset=utf-8']],
  ['/vault.css', ['vault.css','text/css; charset=utf-8']],
  ['/storage', ['storage.html','text/html; charset=utf-8']],
  ['/storage.js', ['storage.js','text/javascript; charset=utf-8']],
  ['/storage.css', ['storage.css','text/css; charset=utf-8']],
  ['/diagnostics', ['diagnostics.html','text/html; charset=utf-8']],
  ['/diagnostics.js', ['diagnostics.js','text/javascript; charset=utf-8']],
  ['/diagnostic-health.mjs', ['diagnostic-health.mjs','text/javascript; charset=utf-8']],
  ['/tcp-evidence.mjs', ['tcp-evidence.mjs','text/javascript; charset=utf-8']],
  ['/diagnostics.css', ['diagnostics.css','text/css; charset=utf-8']],
  ['/relays', ['relays.html','text/html; charset=utf-8']],
  ['/relays.js', ['relays.js','text/javascript; charset=utf-8']],
  ['/relays.css', ['relays.css','text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/legacy',['index.html','text/html; charset=utf-8']],
  ...['app.js','i18n.js','desktop.js','history.js','setup.js'].map(file=>['/'+file,[file,'text/javascript; charset=utf-8']]),
  ['/style.css',['style.css','text/css; charset=utf-8']],
]);

const server = http.createServer(async (req, res) => {
  let securityContext;
  const bearer=String(req.headers.authorization||'').replace(/^Bearer /,'');
  const abort = new AbortController();
  res.once('close', () => { if (!res.writableEnded) abort.abort(); });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (code, data) => {
    if(code===200&&securityContext&&vault.configured){
      try{vault.actor(bearer,securityContext);}catch{code=423;data={error:'vault_locked'};}
    }
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
  };
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`))
    return json(403, { error: 'local_origin_required' });
  try {
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/api/health')
      return json(200, { app: 'trafficwatch-overview', version: VERSION, collectorPid: process.pid, readOnly: true,
        performance: { quick: quickReader.stats(), history: fullReader.stats(), detail:detailReader.stats(),cachedQueries: cache.size } });
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-codex-flow'] !== '1') return json(403, { error: 'local_header_required' });
      if(await vaultRoute({req,url,json,vault,readJson,clearCache}))return;
      if(await diagnosticRoute({req,url,json,vault,readJson,dataRoot,token:bearer}))return;
      if(req.method==='GET'&&url.pathname==='/api/overview-progress'){
        if(vault.configured){vault.owner(bearer);securityContext={operation:'read'};}
        const range=url.searchParams.get('range')||'today',date=url.searchParams.get('date')||undefined;
        if(!['today','24h','7d','30d','all','day','month'].includes(range))return json(400,{error:'invalid_range'});
        return json(200,{query:fullReader.progressFor({type:'overview',range,date}),initialization:vault.initialization||null,ready:!vault.configured||vault.ready});
      }
      if(url.pathname==='/api/relay-targets'){
        vault.owner(bearer);
        if(req.method==='GET'){
          const config=readRelayTargetConfig(dataRoot,settings.RelayHosts),backups=listRelayTargetBackups(dataRoot);
          const relayDir=path.join(dataRoot,'relay-bypass');let status=null,applied=null;
          try{status=JSON.parse(fs.readFileSync(path.join(relayDir,'status.json'),'utf8'));if(Date.now()-status.at>150000)status={...status,state:'stale'};}catch{}
          try{applied=JSON.parse(fs.readFileSync(path.join(relayDir,'targets.json'),'utf8'));}catch{}
          const disabled=fs.existsSync(path.join(relayDir,'disabled'))||fs.existsSync(path.join(dataRoot,'stop.request'));
          const pending=relayHostRevision(config.targets.filter(target=>target.enabled).map(target=>target.host))!==applied?.hostRevision;
          return json(200,{...config,backups,status,applied,disabled,pending});
        }
        if(req.method!=='POST')return json(405,{error:'method_not_allowed'});
        const body=await readJson(req,65536);vault.owner(bearer);let result;
        const saveOptions={legacyHosts:settings.RelayHosts,expectedRevision:body.revision};
        if(body.action==='save')result=saveRelayTargets(dataRoot,body.targets,saveOptions);
        else if(body.action==='delete'){
          const current=readRelayTargetConfig(dataRoot,settings.RelayHosts);
          if(typeof body.id!=='string'||!current.targets.some(target=>target.id===body.id))throw new Error('relay_target_not_found');
          result=saveRelayTargets(dataRoot,current.targets.filter(target=>target.id!==body.id),saveOptions);
        }else if(body.action==='restore')result=restoreRelayTargets(dataRoot,body.id,saveOptions);
        else if(body.action==='disable-all')result=saveRelayTargets(dataRoot,readRelayTargetConfig(dataRoot,settings.RelayHosts).targets.map(target=>({...target,enabled:false})),saveOptions);
        else if(body.action==='apply'){
          const at=queueRelayReconcile();
          vault.actor(bearer,{operation:'update'});vault.audit('owner','relay-targets-apply',{at});
          return json(202,{queued:true,at});
        }else return json(400,{error:'invalid_relay_action'});
        const at=queueRelayReconcile();vault.actor(bearer,{operation:'update'});vault.audit('owner','relay-targets-'+body.action,{count:result.targets.length,at});
        return json(200,{...result,at,queued:true});
      }
      if(url.pathname==='/api/airport-groups'){
        if(req.method==='GET'){
          if(vault.configured){vault.owner(bearer);securityContext={operation:'read',lane:'clash'};}
          return json(200,await quickReader.query({type:'airport-groups'},{signal:abort.signal}));
        }
        if(req.method!=='POST')return json(405,{error:'method_not_allowed'});
        const body=await readJson(req,65536);if(vault.configured){vault.owner(bearer);securityContext={operation:'update'};}
        const groups=normalizeAirportGroups(body.groups);
        if(vault.configured){
          const saved=await vault.callWriter({action:'airport-groups-set',lane:'clash',groups});vault.owner(bearer);clearCache();return json(200,saved);
        }
        const response=await fetch(`http://127.0.0.1:${collectorPorts[1]}/api/airport-groups`,{method:'POST',headers:{'x-codex-flow':'1','content-type':'application/json'},body:JSON.stringify({groups}),signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw new Error('airport_groups_save_failed');
        const saved=await response.json();clearCache();return json(200,saved);
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        json(200, { ok: true }); setTimeout(close, 100); return;
      }
      let actor;
      if(vault.configured){
        securityContext={operation:url.pathname==='/api/harness-apps'&&req.method==='POST'?'rules':url.searchParams.get('export')==='1'?'export':'read',lane:['/api/detail','/api/harness'].includes(url.pathname)?(url.searchParams.get('lane')||'windows'):['/api/ladder','/api/ladder/nodes'].includes(url.pathname)?'clash':undefined};
        actor=vault.actor(bearer,securityContext);
        if(req.method==='GET'&&url.pathname==='/api/live'){
          if(!actor.owner)return json(403,{error:'grant_live_not_available'});
          return json(200,await livePacket());
        }
        if(!vault.ready)return json(503,{error:'vault_migrating'});
        if(vault.storageBusy)return json(503,{error:'vault_storage_busy'});
      }
      const authorization=actor&&!actor.owner?{authorizedWindows:actor.windows,allowedLanes:actor.lanes}:{};
      if(actor?.owner&&['running','paused'].includes(vault.backgroundImport?.state))authorization.skipRollup=true;
      if(url.pathname.startsWith('/api/legacy/')){
        if(vault.configured)vault.owner(bearer);
        const match=/^\/api\/legacy\/(windows|clash)\/(dashboard|calendar|report|correlation|export|settings|capture|stop|update|diagnostics)$/.exec(url.pathname);
        if(!match)return json(404,{error:'not_found'});
        const [,lane,operation]=match,route='/api/'+operation,collectorPort=collectorPorts[lane==='windows'?0:1];
        if(req.method==='POST'){
          if(!['settings','capture','stop'].includes(operation))return json(403,{error:'legacy_operation_unavailable'});
          const body=await readJson(req),response=await fetch(`http://127.0.0.1:${collectorPort}${route}`,{method:'POST',headers:{'x-codex-flow':'1','content-type':'application/json',...(vault.configured?{'x-trafficwatch-command':signCommand(route,body,vault.secrets)}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
          return json(response.status,await response.json());
        }
        if(operation==='update')return json(200,{supported:false,state:'unavailable',current:'0.8.0'});
        if(operation==='diagnostics')return json(200,{app:'trafficwatch',protected:vault.configured,legacy:true});
        const packet=await livePacket();
        const result=await fullReader.query({type:'legacy',options:{lane,route,params:url.searchParams.toString(),live:packet.live[lane==='windows'?'machine':'clash']}},{signal:abort.signal});
        if(vault.configured)vault.owner(bearer);
        if(operation==='export'){
          const columns=['host','process','pid','scope','evidence','network','up','down','last_seen'];
          res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="trafficwatch-connections.csv"'});res.end('\uFEFF'+[columns.join(','),...result.rows.map(row=>columns.map(column=>csvCell(row[column])).join(','))].join('\r\n'));return;
        }
        return json(200,result);
      }
      if(actor&&!actor.owner)vault.audit(actor.id,'query',{route:url.pathname,range:url.searchParams.get('range'),lane:securityContext.lane});
      if (req.method === 'GET' && url.pathname === '/api/harness-apps')
        return json(200, { apps: await harnessApps() });
      if (req.method === 'POST' && url.pathname === '/api/harness-apps') {
        const request = await readJson(req);
        try { return json(200, { apps: await updateHarnessApps(request.apps) }); }
        catch (error) { return json(503, { error: error.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        const range = url.searchParams.get('range') || 'today';
        if (!['today', '24h', '7d', '30d', 'all', 'day', 'month'].includes(range)) return json(400, { error: 'invalid_range' });
        const date = url.searchParams.get('date') || undefined;
        const apps = await harnessApps();
        const quick = url.searchParams.get('quick') === '1';
        const [data, packet] = await Promise.all([
          query({ type: 'overview', range, date, options: { apps, quick,...authorization } }, { signal: abort.signal, quick, fresh: url.searchParams.get('fresh') === '1' }),actor&&!actor.owner?{live:{machine:null,clash:null}}:livePacket(),
        ]);
        return json(200, { ...data, apps, live: packet.live,backgroundImport:actor?.owner?vault.backgroundImport||null:undefined,...(actor&&!actor.owner?{authorization:{lanes:actor.lanes,windows:actor.windows,expiresAt:actor.expiresAt}}:{}) });
      }
      if (req.method === 'GET' && url.pathname === '/api/live') {
        if(actor&&!actor.owner)return json(403,{error:'grant_live_not_available'});
        return json(200, await livePacket());
      }
      if(url.pathname==='/api/ladder/nodes'){
        if(req.method!=='GET')return json(405,{error:'method_not_allowed'});
        if(vault.configured){vault.owner(bearer);securityContext={operation:'read',lane:'clash'};if(!vault.ready)return json(503,{error:'vault_migrating'});if(vault.storageBusy)return json(503,{error:'vault_storage_busy'});}
        const range=url.searchParams.get('range')||'today',date=url.searchParams.get('date')||undefined;
        if(!['today','24h','7d','30d','all','day'].includes(range))return json(400,{error:'invalid_range'});
        const result=await query({type:'ladder-nodes',range,options:{lane:'clash',date}},{signal:abort.signal,fresh:true});
        return json(200,result.detail);
      }
      if(req.method==='GET'&&url.pathname==='/api/ladder'){
        const range=url.searchParams.get('range')||'today',client=url.searchParams.get('client')||'all',airport=(url.searchParams.get('airport')||'').slice(0,64),date=url.searchParams.get('date')||undefined;
        if(!['today','24h','7d','30d','all','day'].includes(range))return json(400,{error:'invalid_range'});
        if(!['all','verge','flclash','mihomo','legacy'].includes(client)||airport&&!/^__unassigned__$|^[a-zA-Z0-9_-]{1,64}$/.test(airport))return json(400,{error:'invalid_filter'});
        const options={lane:'clash',client,airport,date,apps:await harnessApps(),...authorization};
        const result=await query({type:'ladder',range,options},{signal:abort.signal,fresh:url.searchParams.get('fresh')==='1'});
        return json(200,{...result.detail,...(actor&&!actor.owner?{authorization:{lanes:actor.lanes,windows:actor.windows,expiresAt:actor.expiresAt}}:{})});
      }
      if (req.method === 'GET' && ['/api/detail','/api/harness'].includes(url.pathname)) {
        const lane = url.searchParams.get('lane') || 'windows';
        if (!['windows', 'clash'].includes(lane)) return json(400, { error: 'invalid_lane' });
        const range = url.searchParams.get('range') || 'today';
        if (!['today', '24h', '7d', '30d', 'all', 'day'].includes(range)) return json(400, { error: 'invalid_range' });
        const route = url.searchParams.get('route') || 'all';
        if (!['all', 'proxy', 'direct', 'unknown'].includes(route)) return json(400, { error: 'invalid_route' });
        const options = {
          lane,
          process: (url.searchParams.get('process') || '').slice(0, 128),
          host: (url.searchParams.get('host') || '').slice(0, 255),
          node: (url.searchParams.get('node') || '').slice(0, 255),
          scope: url.searchParams.get('scope') || undefined,
          page: url.searchParams.get('page') || 0,
          export: url.searchParams.get('export') === '1',
          family: url.searchParams.get('family') || '',
          route,
          client:url.searchParams.get('client')||'',
          airport:(url.searchParams.get('airport')||'').slice(0,64),
          date: url.searchParams.get('date') || undefined,
          from: url.searchParams.has('from') ? url.searchParams.get('from') : undefined,
          to: url.searchParams.has('to') ? url.searchParams.get('to') : undefined,
          apps: await harnessApps(),
          ...authorization,
        };
        if (options.family && !['codex', 'claude', 'dsh'].includes(options.family)) return json(400, { error: 'invalid_family' });
        if(options.client&&!['all','verge','flclash','mihomo','legacy'].includes(options.client))return json(400,{error:'invalid_client'});
        if(options.airport&&!/^__unassigned__$|^[a-zA-Z0-9_-]{1,64}$/.test(options.airport))return json(400,{error:'invalid_airport'});
        if(url.pathname==='/api/harness'&&!options.family)return json(400,{error:'invalid_family'});
        if (options.scope && !['codex','other','unknown'].includes(options.scope)) return json(400, { error: 'invalid_scope' });
        if (options.export) options.export = true;
        const result = await query({ type: url.pathname==='/api/harness'?'harness':'detail', range, options }, { signal: abort.signal,fresh:url.searchParams.get('fresh')==='1' });
        return json(200, {...result.detail,...(actor&&!actor.owner?{authorization:{lanes:actor.lanes,windows:actor.windows,expiresAt:actor.expiresAt}}:{})});
      }
      return json(404, { error: 'not_found' });
    }
    const asset = assets.get(url.pathname);
    if (req.method !== 'GET' || !asset) return json(404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': asset[1] });
    fs.createReadStream(path.join(root, 'public', asset[0])).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    if (res.destroyed || error.message === 'request_cancelled') return;
    const publicError=/^(vault_|grant_|relay_|invalid_relay|duplicate_relay|invalid_airport_|airport_groups_)/.test(error.message)||['invalid_range','history_busy','history_timeout'].includes(error.message);
    if (!res.headersSent) json(['vault_migrating','vault_busy','vault_storage_busy','airport_groups_save_failed'].includes(error.message)?503:/^(vault_|grant_)/.test(error.message)?423:/^(relay_|invalid_relay|duplicate_relay|invalid_airport_)/.test(error.message)||['invalid_range','Invalid range','Invalid date'].includes(error.message)?400:503, { error: publicError ? error.message : 'history_unavailable' });
    else res.end();
  }
});

function close() {
  server.close(); server.closeIdleConnections();vault.close(); fullReader.close(); quickReader.close();detailReader.close();
  process.removeListener('SIGINT',close);process.removeListener('SIGTERM',close);
}
server.on('error', () => {vault.close(); fullReader.close(); quickReader.close();detailReader.close(); process.exit(1); });
server.listen(port, '127.0.0.1');
process.once('SIGINT', close);
process.once('SIGTERM', close);
return {server,vault,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))startOverviewServer();

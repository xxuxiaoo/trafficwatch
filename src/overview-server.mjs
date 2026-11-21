import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HistoryReader } from './history-reader.mjs';
import { normalizeHarnessApps } from './harness.mjs';
import { VERSION } from './version.mjs';
import { diagnosticRoute } from './ai-diagnostic-router.mjs';
import {readRelayTargetConfig,listRelayTargetBackups,saveRelayTargets,restoreRelayTargets,requestRelayReconcile,relayHostRevision} from './relay-targets.mjs';
import {BackgroundHistoryRefreshes} from './history-background-refresh.mjs';
import {loadConfig} from './config.mjs';
import { historyDirectory } from './history-paths.mjs';
import { HistoryMaintenance } from './history-maintenance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL_ACTIONS = new Set(['Start','PauseCapture','Stop','EnableStartup','DisableStartup','StartDiagnostics','StopDiagnostics','EnableBypass','RollbackBypass','ReopenTray']);
const controlErrors = new Set(['control_helper_missing','control_action_timeout','control_action_interrupted','control_action_failed','control_action_cancelled','control_action_busy','control_status_invalid','control_session_required']);
const validAirport = value => value === '' || value === '__unassigned__' || /^airport-[a-f0-9]{24}$/.test(value);

function runInstalledControl(action, directory=root){
  const executable=path.join(directory,'TrafficWatch-Control.exe');
  if(!fs.existsSync(executable)||!fs.existsSync(path.join(directory,'suite-settings.json')))return Promise.reject(new Error('control_helper_missing'));
  const status=action==='Status';
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,status?['--status']:['--action',action==='Stop'?'StopFromOverview':action],{cwd:directory,windowsHide:true,stdio:['ignore','pipe','ignore']});
    let output='';child.stdout.setEncoding('utf8');
    child.stdout.on('data',text=>{if(output.length<=8192)output+=text;});
    const timer=setTimeout(()=>{child.kill();reject(new Error('control_action_timeout'));},status?6500:78000);
    child.once('error',error=>{clearTimeout(timer);reject(new Error(error.code==='ENOENT'?'control_helper_missing':'control_action_failed'));});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);
      if(code!==0)return reject(new Error(signal?'control_action_interrupted':code===3?'control_action_cancelled':code===4?'control_session_required':'control_action_failed'));
      if(!status)return resolve({ok:true,action});
      try{
        const value=JSON.parse(output),fields=['Startup','Diagnostics','Bypass','Tray','Supervisor'];
        if(output.length>8192||!fields.every(key=>typeof value?.[key]==='string'&&value[key].length<=180))throw new Error('control_status_invalid');
        if(typeof value.CapturePaused!=='boolean')throw new Error('control_status_invalid');
        resolve({...Object.fromEntries(fields.map(key=>[key,value[key]])),CapturePaused:value.CapturePaused});
      }catch(error){reject(new Error('control_status_invalid',{cause:error}));}
    });
  });
}

export function startOverviewServer({listenPort,suiteSettings,historyRoot,sourcePorts,readerFactory=(data,options)=>new HistoryReader(data,options),controlRunner=runInstalledControl}={}){
const settingsPath = path.join(root, 'suite-settings.json');
const settings = suiteSettings||(fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''))
  : {});
const dataRoot = path.resolve(historyRoot||process.env.TRAFFICWATCH_DATA_ROOT || settings.DataRoot || path.join(root, 'data'));
const singleCollector = !settings.DataRoot && process.env.TRAFFICWATCH_SINGLE_COLLECTOR === '1'
  ? (process.env.TRAFFICWATCH_DEMO === '1'?'demo':loadConfig(root).captureMode) : null;
const port = Number(listenPort||process.env.TRAFFICWATCH_OVERVIEW_PORT || 43131);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid overview port');
const host = `127.0.0.1:${port}`;
const collectorPorts=sourcePorts||[Number(process.env.TRAFFICWATCH_MACHINE_PORT||43128),Number(process.env.TRAFFICWATCH_CLASH_PORT||43130)];
if(collectorPorts.some(value=>!Number.isInteger(value)||value<1024||value>65535))throw new Error('Invalid collector port');
const cacheRoot = process.env.TRAFFICWATCH_CACHE_ROOT || path.join(dataRoot, 'viewer-cache');
function queueRelayReconcile(){
  const config=readRelayTargetConfig(dataRoot,settings.RelayHosts);
  if(config.targets.some(target=>target.enabled))try{fs.unlinkSync(path.join(dataRoot,'relay-bypass','disabled'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return requestRelayReconcile(dataRoot);
}
const makeReader = role => readerFactory({ dataRoot, singleCollector, ...(role === 'history' ? { cacheRoot } : {}) },
  { timeoutMs: role === 'quick' ? 12000 : role === 'detail' ? 20000 : 45000 }, role);
let fullReader = makeReader('history');
const quickReader = makeReader('quick'), detailReader = makeReader('detail');
const maintenance = new HistoryMaintenance({ dataRoot, cacheRoot, singleCollector });
const cache = new Map(), backgroundRefreshes = new BackgroundHistoryRefreshes();
let appsCache = null, appsPending = null, liveCache = null, livePending = null,cacheGeneration=0;
let controlPending, controlStatusPending, controlStatusCache;
let stoppingFromOverview = false;
const clearCache=()=>{cacheGeneration++;cache.clear();backgroundRefreshes.cancelAll();appsCache=appsPending=liveCache=livePending=null;};
function storeCache(key, data) {
  cache.delete(key); cache.set(key, { at: Date.now(), data, size: JSON.stringify(data).length });
  let size = [...cache.values()].reduce((n,item) => n+item.size,0);
  while (cache.size > 24 || size > 8000000) { const oldest = cache.keys().next().value; size -= cache.get(oldest).size; cache.delete(oldest); }
}
async function query(payload, { signal, quick = false, fresh = false } = {}) {
  const key = JSON.stringify([payload, new Date(Date.now()+8*3600000).toISOString().slice(0,10)]);
  const entry = cache.get(key), ttl = quick ? 10000 : payload.type === 'detail' ? 30000 : 60000;
  const reader = quick ? quickReader : ['detail','harness','ladder'].includes(payload.type)?detailReader:fullReader,currentGeneration=cacheGeneration;
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
    const data = await response.json();
    return data.app === 'trafficwatch-live' ? data : null;
  } catch { return null; }
}

async function harnessApps() {
  if (appsCache && Date.now() - appsCache.at < 5000) return appsCache.apps;
  if (appsPending) return appsPending;
  appsPending = loadHarnessApps().finally(()=>{appsPending=null;}); return appsPending;
}
async function loadHarnessApps() {
  const saved = await quickReader.query({ type: 'apps' });
  appsCache = { at: Date.now(), apps: saved.apps };
  return saved.apps;
}

async function livePacket() {
  if (liveCache && Date.now()-liveCache.at < 1500) return liveCache.value;
  if (!livePending) livePending = (singleCollector ? live(collectorPorts[0]).then(packet=>singleCollector==='mihomo'?[null,packet]:[packet,null]) : Promise.all(collectorPorts.map(live))).then(([machine,clash])=>{
    const installedControls=Boolean(settings.DataRoot),capturePaused=installedControls&&fs.existsSync(path.join(dataRoot,'capture-paused'));
    const value = { live: { machine,clash,installedControls,capturePaused,...(singleCollector?{singleCollector}:{}) },generatedAt:Date.now() }; liveCache = { at:Date.now(),value }; return value;
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
  const targets = singleCollector ? collectorPorts.slice(0,1) : collectorPorts;
  const previous = await Promise.all(targets.map(async (collectorPort) => {
    const response = await fetch(`http://127.0.0.1:${collectorPort}/api/harness-apps`, {
      headers: { 'x-codex-flow': '1' }, signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Both collectors must be connected to save Harness rules');
    return (await response.json()).apps;
  }));
  const changed = [];
  try {
    for (const [index, collectorPort] of targets.entries()) {
      const response = await fetch(`http://127.0.0.1:${collectorPort}/api/harness-apps`, {
        method: 'POST',
        headers: { 'x-codex-flow': '1', 'content-type': 'application/json' },
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
        const response = await fetch(`http://127.0.0.1:${targets[index]}/api/harness-apps`, {
          method: 'POST', headers: { 'x-codex-flow': '1', 'content-type': 'application/json' },
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
]);

const server = http.createServer(async (req, res) => {
  const abort = new AbortController();
  res.once('close', () => { if (!res.writableEnded) abort.abort(); });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
  };
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`))
    return json(403, { error: 'local_origin_required' });
  try {
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/api/health')
      return json(200, { app: 'trafficwatch-overview', version: VERSION, collectorPid: process.pid, storage: 'sqlite-wal', singleCollector,
        performance: { quick: quickReader.stats(), history: fullReader.stats(), detail:detailReader.stats(),cachedQueries: cache.size } });
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-codex-flow'] !== '1') return json(403, { error: 'local_header_required' });
      if (req.method === 'POST' && url.pathname !== '/api/stop' && req.headers['content-type']?.split(';', 1)[0] !== 'application/json')
        return json(415, { error: 'json_content_type_required' });
      // Refuse an incomplete data conversion instead of creating a second history.
      historyDirectory(dataRoot, 'windows', { singleCollector });
      if(await diagnosticRoute({req,url,json,maintenance,readJson,dataRoot}))return;
      if (url.pathname === '/api/storage' && req.method === 'GET')
        return json(200, await maintenance.request('storage-status', { fresh: url.searchParams.get('fresh') === '1' }));
      if (req.method === 'POST' && /^\/api\/storage\/(run|compact|cache|policy)$/.test(url.pathname)) {
        const operation = url.pathname.split('/').at(-1), body = await readJson(req);
        if (operation === 'cache') {
          const previous = fullReader;
          await previous.close(); clearCache();
          try { return json(200, await maintenance.request('storage-cache')); }
          finally { fullReader = makeReader('history'); }
        }
        return json(operation === 'policy' ? 200 : 202, await maintenance.request('storage-' + operation, { policy: body }));
      }
      if(req.method==='GET'&&url.pathname==='/api/overview-progress'){
        const range=url.searchParams.get('range')||'today',date=url.searchParams.get('date')||undefined;
        if(!['today','24h','7d','30d','all','day','month'].includes(range))return json(400,{error:'invalid_range'});
        return json(200,{query:fullReader.progressFor({type:'overview',range,date}),ready:true});
      }
      if(url.pathname==='/api/relay-targets'){
        if(req.method==='GET'){
          const config=readRelayTargetConfig(dataRoot,settings.RelayHosts),backups=listRelayTargetBackups(dataRoot);
          const relayDir = path.join(dataRoot, 'relay-bypass');
          const read = filename => {
            try { return JSON.parse(fs.readFileSync(path.join(relayDir, filename), 'utf8')); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
          };
          let status = read('status.json');
          if (status && Date.now() - status.at > 150000) status = { ...status, state: 'stale' };
          const applied = read('targets.json');
          const disabled=fs.existsSync(path.join(relayDir,'disabled'))||fs.existsSync(path.join(dataRoot,'stop.request'));
          const pending=relayHostRevision(config.targets.filter(target=>target.enabled).map(target=>target.host))!==applied?.hostRevision;
          return json(200,{...config,backups,status,applied,disabled,pending});
        }
        if(req.method!=='POST')return json(405,{error:'method_not_allowed'});
        const body=await readJson(req,65536);let result;
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
          return json(202,{queued:true,at});
        }else return json(400,{error:'invalid_relay_action'});
        const at=queueRelayReconcile();
        return json(200,{...result,at,queued:true});
      }
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        json(200, { ok: true }); setTimeout(close, 100); return;
      }
      if(url.pathname==='/api/control/status'||url.pathname==='/api/control/action'){
        if(url.pathname==='/api/control/status'&&req.method==='GET'){
          if(controlStatusCache&&Date.now()-controlStatusCache.at<10000)return json(200,controlStatusCache.value);
          controlStatusPending??=Promise.resolve().then(()=>controlRunner('Status',root)).finally(()=>{controlStatusPending=null;});
          const value=await controlStatusPending;
          controlStatusCache={at:Date.now(),value};return json(200,value);
        }
        if(url.pathname!=='/api/control/action'||req.method!=='POST')return json(405,{error:'method_not_allowed'});
        if(req.headers.origin!==`http://${host}`)return json(403,{error:'invalid_control_origin'});
        const body=await readJson(req);
        if(typeof body?.action!=='string'||!CONTROL_ACTIONS.has(body.action))return json(400,{error:'invalid_control_action'});
        if(controlPending||stoppingFromOverview)return json(409,{error:'control_action_busy'});
        controlPending=Promise.resolve().then(()=>controlRunner(body.action,root));
        try {
          const result=await controlPending; controlStatusCache=null; liveCache=null;
          if (body.action === 'Stop') {
            // The elevated helper has verified that the other components stopped.
            // Return its result, then shut down this last component as well.
            stoppingFromOverview = true;
            const stopViewer = () => setTimeout(close, 100);
            if (res.destroyed) stopViewer();
            else res.once('close', stopViewer);
          }
          return json(200,result);
        } finally { controlPending=null; }
      }
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
          query({ type: 'overview', range, date, options: { apps, quick } }, { signal: abort.signal, quick, fresh: url.searchParams.get('fresh') === '1' }),livePacket(),
        ]);
        return json(200, { ...data, apps, live: packet.live });
      }
      if (req.method === 'GET' && url.pathname === '/api/live') {
        return json(200, await livePacket());
      }
      if(req.method==='GET'&&url.pathname==='/api/ladder'){
        const range=url.searchParams.get('range')||'today',client=url.searchParams.get('client')||'all',airport=url.searchParams.get('airport')||'',date=url.searchParams.get('date')||undefined;
        if(!['today','24h','7d','30d','all','day'].includes(range))return json(400,{error:'invalid_range'});
        if(!['all','verge','flclash','mihomo','legacy'].includes(client)||!validAirport(airport))return json(400,{error:'invalid_filter'});
        const options={lane:'clash',client,airport,date,apps:await harnessApps()};
        const result=await query({type:'ladder',range,options},{signal:abort.signal,fresh:url.searchParams.get('fresh')==='1'});
        return json(200,result.detail);
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
          airport:url.searchParams.get('airport')||'',
          date: url.searchParams.get('date') || undefined,
          from: url.searchParams.has('from') ? url.searchParams.get('from') : undefined,
          to: url.searchParams.has('to') ? url.searchParams.get('to') : undefined,
          apps: await harnessApps(),
        };
        if (options.family && !['codex', 'claude', 'dsh'].includes(options.family)) return json(400, { error: 'invalid_family' });
        if(options.client&&!['all','verge','flclash','mihomo','legacy'].includes(options.client))return json(400,{error:'invalid_client'});
        if(!validAirport(options.airport)||options.airport&&lane!=='clash')return json(400,{error:'invalid_airport'});
        if(url.pathname==='/api/harness'&&!options.family)return json(400,{error:'invalid_family'});
        if (options.scope && !['codex','other','unknown'].includes(options.scope)) return json(400, { error: 'invalid_scope' });
        if (options.export) options.export = true;
        const result = await query({ type: url.pathname==='/api/harness'?'harness':'detail', range, options }, { signal: abort.signal,fresh:url.searchParams.get('fresh')==='1' });
        return json(200, result.detail);
      }
      return json(404, { error: 'not_found' });
    }
    const asset = assets.get(url.pathname);
    if (req.method !== 'GET' || !asset) return json(404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': asset[1] });
    fs.createReadStream(path.join(root, 'public', asset[0])).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    if (res.destroyed || abort.signal.aborted) return;
    if(!res.headersSent&&controlErrors.has(error.message))return json(503,{error:error.message});
    const invalid = /^(invalid_|relay_|duplicate_relay)/.test(error.message) || error instanceof RangeError;
    const known = invalid || /^(history_|storage_|archive_|diagnostic_)/.test(error.message);
    if (!known) console.error('TrafficWatch request failed:', error.code || error.name);
    if (!res.headersSent) json(invalid ? 400 : 503, { error: known ? error.message : 'history_unavailable' });
    else res.end();
  }
});

function close() {
  server.close(); server.closeIdleConnections();
  process.removeListener('SIGINT',close);process.removeListener('SIGTERM',close);
  return Promise.all([maintenance.close(), fullReader.close(), quickReader.close(), detailReader.close()]);
}
server.on('error', () => {maintenance.close(); fullReader.close(); quickReader.close();detailReader.close(); process.exit(1); });
server.listen(port, '127.0.0.1', () => { if (settings.DataRoot && !maintenance.worker) maintenance.start(); });
process.once('SIGINT', close);
process.once('SIGTERM', close);
return {server,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))startOverviewServer();

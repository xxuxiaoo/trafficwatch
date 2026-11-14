import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { HistoryReader } from './history-reader.mjs';
import { DEFAULT_CODEX_PROCESS_NAMES, normalizeHarnessApps } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = path.join(root, 'suite-settings.json');
const settings = fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''))
  : {};
const dataRoot = path.resolve(process.env.TRAFFICWATCH_DATA_ROOT || settings.DataRoot || path.join(root, 'data'));
const port = Number(process.env.TRAFFICWATCH_OVERVIEW_PORT || 43131);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid overview port');
const host = `127.0.0.1:${port}`;
const cacheRoot = process.env.TRAFFICWATCH_CACHE_ROOT || path.join(dataRoot, 'viewer-cache');
const fullReader = new HistoryReader({ dataRoot, cacheRoot });
const quickReader = new HistoryReader({ dataRoot }, { timeoutMs: 12000 });
const cache = new Map(), updating = new Set();
let appsCache = null, appsPending = null, liveCache = null, livePending = null;
function storeCache(key, data) {
  cache.delete(key); cache.set(key, { at: Date.now(), data, size: JSON.stringify(data).length });
  let size = [...cache.values()].reduce((n,item) => n+item.size,0);
  while (cache.size > 24 || size > 8000000) { const oldest = cache.keys().next().value; size -= cache.get(oldest).size; cache.delete(oldest); }
}
async function query(payload, { signal, quick = false, fresh = false } = {}) {
  const key = JSON.stringify([payload, new Date(Date.now()+8*3600000).toISOString().slice(0,10)]);
  const entry = cache.get(key), ttl = quick ? 10000 : payload.type === 'detail' ? 30000 : 60000;
  const reader = quick ? quickReader : fullReader;
  const load = async (signal) => {
    const result = await reader.query(payload, { signal });
    const data = { ...result, generatedAt: Date.now() };
    // An unreadable lane must not evict a previous good snapshot.
    if (!data.machine || data.machine.available || data.clash?.available) storeCache(key,data);
    return data;
  };
  if (entry && !(fresh && Date.now()-entry.at > 1000)) {
    cache.delete(key); cache.set(key,entry);
    if (Date.now()-entry.at >= ttl && !updating.has(key)) {
      updating.add(key); load().catch(()=>{}).finally(()=>updating.delete(key));
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
  try {
    const response = await fetch('http://127.0.0.1:43128/api/harness-apps', {
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
  if (!livePending) livePending = Promise.all([live(43128),live(43130)]).then(([machine,clash])=>{
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
  const previous = await Promise.all([43128, 43130].map(async (collectorPort) => {
    const response = await fetch(`http://127.0.0.1:${collectorPort}/api/harness-apps`, {
      headers: { 'x-codex-flow': '1' }, signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Both collectors must be connected to save Harness rules');
    return (await response.json()).apps;
  }));
  const changed = [];
  try {
    for (const [index, collectorPort] of [43128, 43130].entries()) {
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
        const response = await fetch(`http://127.0.0.1:${[43128,43130][index]}/api/harness-apps`, {
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
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`))
    return json(403, { error: 'local_origin_required' });
  try {
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/api/health')
      return json(200, { app: 'trafficwatch-overview', version: '0.7.2', collectorPid: process.pid, readOnly: true,
        performance: { quick: quickReader.stats(), history: fullReader.stats(), cachedQueries: cache.size } });
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-codex-flow'] !== '1') return json(403, { error: 'local_header_required' });
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        json(200, { ok: true }); setTimeout(close, 100); return;
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
          query({ type: 'overview', range, date, options: { apps, quick } }, { signal: abort.signal, quick, fresh: url.searchParams.get('fresh') === '1' }), livePacket(),
        ]);
        return json(200, { ...data, apps, live: packet.live });
      }
      if (req.method === 'GET' && url.pathname === '/api/live') {
        return json(200, await livePacket());
      }
      if (req.method === 'GET' && url.pathname === '/api/detail') {
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
          date: url.searchParams.get('date') || undefined,
          from: url.searchParams.has('from') ? url.searchParams.get('from') : undefined,
          to: url.searchParams.has('to') ? url.searchParams.get('to') : undefined,
          apps: await harnessApps(),
        };
        if (options.family && !['codex', 'claude', 'dsh'].includes(options.family)) return json(400, { error: 'invalid_family' });
        if (options.scope && !['codex','other','unknown'].includes(options.scope)) return json(400, { error: 'invalid_scope' });
        if (options.export) options.export = true;
        const result = await query({ type: 'detail', range, options }, { signal: abort.signal });
        return json(200, result.detail);
      }
      return json(404, { error: 'not_found' });
    }
    const asset = assets.get(url.pathname);
    if (req.method !== 'GET' || !asset) return json(404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': asset[1] });
    fs.createReadStream(path.join(root, 'public', asset[0])).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    if (res.destroyed || error.message === 'request_cancelled') return;
    if (!res.headersSent) json(error.message === 'Invalid range' || error.message === 'Invalid date' || error.message === 'invalid_range' ? 400 : 503, { error: ['invalid_range','history_busy','history_timeout'].includes(error.message) ? error.message : 'history_unavailable' });
    else res.end();
  }
});

function close() {
  server.close(); server.closeIdleConnections(); fullReader.close(); quickReader.close();
  setTimeout(() => process.exit(0), 200).unref();
}
server.on('error', () => { fullReader.close(); quickReader.close(); process.exit(1); });
server.listen(port, '127.0.0.1');
process.once('SIGINT', close);
process.once('SIGTERM', close);

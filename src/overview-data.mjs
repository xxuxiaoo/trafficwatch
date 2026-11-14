import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { DEFAULT_CODEX_PROCESS_NAMES, normalizeHarnessApps } from './harness.mjs';
import { programRollup, codexScopeCandidates } from './history-rollup.mjs';

const MINUTE = 60000, DAY = 86400000;
const timeZone = 'Asia/Shanghai';
const zero = () => ({ up: 0, down: 0 });
const amount = (row) => Number(row?.up || 0) + Number(row?.down || 0);
const dateAt = (at) => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

// All API intervals use inclusive starts and exclusive ends. Connection data is
// minute resolution; never include the next minute in a clicked five-minute peak.
export function overviewRange(name, now, firstAt, date) {
  const today = dateAt(now);
  let from, to = now;
  if (name === 'day') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new RangeError('Invalid date');
    from = Date.parse(`${date}T00:00:00+08:00`);
    if (!Number.isFinite(from) || dateAt(from) !== date || date > today) throw new RangeError('Invalid date');
    to = Math.min(now, from + DAY);
  } else if (name === 'today') from = Date.parse(`${today}T00:00:00+08:00`);
  else if (name === 'month') from = Date.parse(`${today.slice(0, 7)}-01T00:00:00+08:00`);
  else if (name === 'all') from = firstAt ?? now;
  else {
    const widths = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
    if (!Object.hasOwn(widths, name)) throw new RangeError('Invalid range');
    from = now - widths[name];
  }
  return { name, from: Math.max(0, Math.floor(from / MINUTE) * MINUTE), to, timeZone };
}

function resolveRange(db, name, now, options) {
  const firstAt = db.prepare('SELECT MIN(at) at FROM samples').get().at;
  if (options.from === undefined && options.to === undefined) return { firstAt, range: overviewRange(name, now, firstAt, options.date) };
  if (options.from === undefined || options.to === undefined) throw new RangeError('Invalid range');
  const from = Number(options.from), to = Number(options.to);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || from > now)
    throw new RangeError('Invalid range');
  return { firstAt, range: { name: 'custom', from: Math.floor(from / MINUTE) * MINUTE, to: Math.min(now, Math.ceil(to / MINUTE) * MINUTE), timeZone } };
}

function widthFor(range) {
  const span = range.to - range.from;
  if (span <= 2 * 3600000) return MINUTE;
  if (span <= 2 * DAY) return 3600000;
  if (span <= 35 * DAY) return 6 * 3600000;
  return Math.ceil(span / (240 * DAY)) * DAY;
}

function settings(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  try { return row ? JSON.parse(row.value) : fallback; } catch { return fallback; }
}

function harnessApps(db, options = {}) {
  const saved = options.apps ?? settings(db, 'harnessApps', null);
  return normalizeHarnessApps(saved, saved?.codex || DEFAULT_CODEX_PROCESS_NAMES);
}

function definitions(db, apps) {
  const hasFamily = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='connection_families' AND type='table'").get());
  const name = "CASE WHEN b.scope='unknown' THEN '' ELSE c.process END";
  const familyCases = ["WHEN b.scope='unknown' THEN 'unknown'", "WHEN b.scope='codex' THEN 'codex'"];
  for (const family of ['codex', 'claude', 'dsh']) {
    if (apps[family].length) familyCases.push(`WHEN lower(c.process) IN (${apps[family].map(literal).join(',')}) THEN '${family}'`);
  }
  if (hasFamily) {
    for (const family of ['codex', 'claude', 'dsh']) {
      const roots = [`script:${family}`, ...apps[family]];
      familyCases.push(`WHEN f.family='${family}' AND f.root_process IN (${roots.map(literal).join(',')}) THEN '${family}'`);
    }
  }
  const family = `CASE ${familyCases.join(' ')} ELSE 'other' END`;
  const leaf = "CASE WHEN json_valid(c.rule) THEN COALESCE(json_extract(c.rule,'$.chains[0]'),'') ELSE '' END";
  const route = `CASE WHEN NOT json_valid(c.rule) THEN 'unknown'
    WHEN COALESCE(json_extract(c.rule,'$.source'),'')<>'mihomo' THEN 'unknown'
    WHEN upper(trim(${leaf}))='DIRECT' THEN 'direct'
    WHEN upper(trim(${leaf})) IN ('','REJECT','REJECT-DROP','PASS','COMPATIBLE') THEN 'unknown'
    ELSE 'proxy' END`;
  return {
    name, family, route, leaf, apps, hasFamily,
    evidence: "CASE WHEN b.scope='unknown' THEN 'none' ELSE c.evidence END",
    pid: "CASE WHEN b.scope='unknown' THEN NULL ELSE c.pid END",
    join: `FROM buckets b JOIN connections c ON c.id=b.connection_id ${hasFamily ? 'LEFT JOIN connection_families f ON f.connection_id=c.id' : ''}`,
    metadataJoin: `JOIN connections c ON c.id=b.connection_id ${hasFamily ? 'LEFT JOIN connection_families f ON f.connection_id=c.id' : ''}`,
  };
}

// Resolve selective metadata once, before touching the much larger bucket table.
// The final bucket predicate still decides family/scope, so candidates may include
// extra IDs without ever relabelling historical unknown or Codex buckets.
function candidateConnections(db, defs, range, options) {
  const clauses = [], params = [];
  if (['codex', 'claude', 'dsh'].includes(options.family)) {
    const family = options.family, names = defs.apps[family];
    const queries = [];
    if (names.length) {
      queries.push(`SELECT id FROM connections WHERE lower(process) IN (${names.map(() => '?').join(',')})`);
      params.push(...names);
    }
    if (defs.hasFamily) {
      const roots = [`script:${family}`, ...names];
      queries.push(`SELECT connection_id id FROM connection_families WHERE family=? AND root_process IN (${roots.map(() => '?').join(',')})`);
      params.push(family, ...roots);
    }
    if (family === 'codex') {
      queries.push('SELECT value id FROM json_each(?)');
      params.push(codexScopeCandidates(db, options.cacheRoot, range));
    }
    clauses.push(queries.length ? `c.id IN (${queries.join(' UNION ')})` : '0');
  }
  if (options.process && options.process !== '__unknown__') {
    clauses.push('lower(c.process)=?'); params.push(options.process.toLowerCase());
  }
  if (options.host) { clauses.push('c.host=?'); params.push(options.host); }
  if (options.node) { clauses.push(`${defs.leaf}=?`); params.push(options.node); }
  if (options.route && options.route !== 'all') { clauses.push(`${defs.route}=?`); params.push(options.route); }
  if (!clauses.length) return null;
  return JSON.stringify(db.prepare(`SELECT c.id FROM connections c WHERE ${clauses.join(' AND ')}`).all(...params).map((row) => row.id));
}

function filtered(defs, range, options = {}, candidates = null) {
  const clauses = ['b.minute>=?', 'b.minute<?'];
  const params = candidates === null ? [range.from, range.to] : [candidates, range.from, range.to];
  if (options.family) { clauses.push(`${defs.family}=?`); params.push(options.family); }
  if (options.process === '__unknown__') clauses.push("b.scope='unknown'");
  else if (options.process) { clauses.push(`lower(${defs.name})=?`); params.push(options.process.toLowerCase()); }
  if (options.scope) { clauses.push('b.scope=?'); params.push(options.scope); }
  if (options.host) { clauses.push('c.host=?'); params.push(options.host); }
  if (options.node) { clauses.push(`${defs.leaf}=?`); params.push(options.node); }
  if (options.route && options.route !== 'all') { clauses.push(`${defs.route}=?`); params.push(options.route); }
  const join = candidates === null ? defs.join
    : `FROM json_each(?) selected CROSS JOIN buckets b ON b.connection_id=selected.value ${defs.metadataJoin}`;
  return { sql: `${join} WHERE ${clauses.join(' AND ')}`, params };
}

function programs(db, defs, filter, limit = 1000) {
  return db.prepare(`${filter.prefix || ''} SELECT ${defs.name} process,${defs.name} name,b.scope,${defs.family} family,
    ${defs.evidence} evidence,SUM(b.up) up,SUM(b.down) down,COUNT(DISTINCT c.id) connections,
    MIN(b.minute) firstAt,MAX(b.last_at) lastAt ${filter.sql}
    GROUP BY 1,b.scope,4 ORDER BY SUM(b.up+b.down) DESC${limit === null ? '' : ' LIMIT ?'}`).all(...filter.params, ...(limit === null ? [] : [limit]))
    .map((row) => ({ ...row, name: row.name || '未识别进程' }));
}

function bucketTotals(db, filter) {
  return db.prepare(`SELECT COALESCE(SUM(b.up),0) up,COALESCE(SUM(b.down),0) down,
    COUNT(DISTINCT c.id) connections,MIN(b.minute) firstAt,MAX(b.last_at) lastAt ${filter.sql}`).get(...filter.params);
}

function grouped(db, filter, expression, limit = 100) {
  return db.prepare(`SELECT ${expression} name,SUM(b.up) up,SUM(b.down) down,COUNT(DISTINCT c.id) connections
    ${filter.sql} GROUP BY 1 ORDER BY SUM(b.up+b.down) DESC LIMIT ?`).all(...filter.params, limit);
}

function connectionSeries(db, defs, filter, width) {
  return db.prepare(`SELECT CAST(b.minute / ? AS INTEGER)*? at,SUM(b.up) up,SUM(b.down) down,
    SUM(CASE WHEN ${defs.route}='proxy' THEN b.up ELSE 0 END) proxyUp,
    SUM(CASE WHEN ${defs.route}='proxy' THEN b.down ELSE 0 END) proxyDown,
    SUM(CASE WHEN ${defs.route}='direct' THEN b.up ELSE 0 END) directUp,
    SUM(CASE WHEN ${defs.route}='direct' THEN b.down ELSE 0 END) directDown,
    SUM(CASE WHEN ${defs.route}='unknown' THEN b.up ELSE 0 END) unknownUp,
    SUM(CASE WHEN ${defs.route}='unknown' THEN b.down ELSE 0 END) unknownDown
    ${filter.sql} GROUP BY 1 ORDER BY 1`).all(width, width, ...filter.params).map((row) => ({
      at: row.at, up: row.up, down: row.down,
      proxy: { up: row.proxyUp, down: row.proxyDown },
      direct: { up: row.directUp, down: row.directDown },
      unknown: { up: row.unknownUp, down: row.unknownDown },
    }));
}

function routeTotals(db, defs, filter) {
  const result = { proxy: zero(), direct: zero(), unknown: zero() };
  for (const row of grouped(db, filter, defs.route, 3)) result[row.name] = { up: row.up, down: row.down };
  return result;
}

function openLane(dataRoot, lane) {
  if (!['windows', 'clash'].includes(lane)) throw new RangeError('Invalid lane');
  const file = path.join(dataRoot, lane, 'monitor.sqlite');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  // These settings affect this read-only connection only. Keep grouping work in
  // memory and avoid thrashing SQLite's default 2 MiB cache on metadata joins.
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=600; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768; BEGIN');
  return db;
}

export function readLane(dataRoot, lane, rangeName, now = Date.now(), options = {}) {
  const began = performance.now(), db = openLane(dataRoot, lane);
  if (!db) return { available: false, error: 'missing_database' };
  try {
    const apps = harnessApps(db, options);
    const { firstAt, range } = resolveRange(db, rangeName, now, options);
    const width = widthFor(range), defs = definitions(db, apps), all = filtered(defs, range);
    const totals = db.prepare(`SELECT COUNT(*) samples,MIN(at) firstAt,MAX(at) lastAt,
      COALESCE(SUM(all_up),0) up,COALESCE(SUM(all_down),0) down,
      COALESCE(SUM(CASE WHEN duration>0 AND duration<=2000 THEN
        MAX(0,MIN(at,?)-MAX(at-duration,?)) ELSE 0 END),0) observedMs
      FROM samples WHERE at>=? AND at<?`).get(range.to, range.from, range.from, range.to);
    const lastAt = db.prepare('SELECT MAX(at) at FROM samples').get().at;
    const gapCount = db.prepare(`SELECT COUNT(*) count FROM collection_gaps WHERE started_at<? AND COALESCE(ended_at,?)>?`)
      .get(range.to, range.to, range.from).count;
    const gapDetails = db.prepare(`SELECT reason,MAX(started_at,?) gapFrom,MIN(COALESCE(ended_at,?),?) gapTo,
      ended_at IS NULL ongoing FROM collection_gaps WHERE started_at<? AND COALESCE(ended_at,?)>?
      ORDER BY started_at DESC LIMIT 100`).all(range.from, range.to, range.to, range.to, range.to, range.from)
      .map((row) => ({ ...row, durationMs: Math.max(0, row.gapTo - row.gapFrom) }));
    const programFilter = lane === 'windows' ? {
      prefix: `WITH usage AS MATERIALIZED (SELECT connection_id,scope,SUM(up) up,SUM(down) down,
        MIN(minute) minute,MAX(last_at) last_at FROM buckets WHERE minute>=? AND minute<? GROUP BY connection_id,scope)`,
      sql: `FROM usage b ${defs.metadataJoin}`,
      params: [range.from, range.to],
    } : all;
    let rolled, cacheWarning;
    const quick = options.quick === true;
    if (!quick && lane === 'windows' && options.cacheRoot) {
      try { rolled = programRollup(db, options.cacheRoot, range, totals.firstAt, now, defs, (cache,filter)=>programs(cache,defs,filter,null)); }
      catch { cacheWarning = 'summary_cache_unavailable'; }
    }
    let completePrograms;
    try {
      completePrograms = quick ? [] : rolled?.rows || (rolled ? programs(rolled.db, defs, {
        ...rolled.filter, sql: `FROM usage b ${defs.metadataJoin}`,
      }, null) : programs(db, defs, programFilter, null));
    } finally { rolled?.db.close(); }
    const allPrograms = completePrograms.slice(0, 1000), connected = zero(), familyTotals = {};
    for (const row of completePrograms) {
      connected.up += row.up; connected.down += row.down;
      const family = familyTotals[row.family] ||= zero();
      family.up += row.up; family.down += row.down;
    }
    const groups = lane === 'clash' ? routeTotals(db, defs, all) : { proxy: zero(), direct: zero(), unknown: zero() };
    const routePrograms = {};
    if (lane === 'clash' && !quick) {
      for (const route of ['proxy', 'direct', 'unknown']) routePrograms[route] = programs(db, defs, filtered(defs, range, { route }));
    }
    const timeline = db.prepare(`SELECT CAST(at / ? AS INTEGER)*? at,SUM(all_up) up,SUM(all_down) down,
      COUNT(*) samples FROM samples WHERE at>=? AND at<? GROUP BY 1 ORDER BY 1`).all(width, width, range.from, range.to);
    const proxy = filtered(defs, range, { route: 'proxy' });
    const routeTimeline = lane === 'clash' ? connectionSeries(db, defs, all, width) : [];
    const peaks = lane === 'windows'
      ? db.prepare(`SELECT CAST(at / ? AS INTEGER)*? at,SUM(all_up) up,SUM(all_down) down,COUNT(*) samples
          FROM samples WHERE at>=? AND at<? GROUP BY 1 ORDER BY SUM(all_up+all_down) DESC LIMIT 10`)
        .all(5 * MINUTE, 5 * MINUTE, range.from, range.to)
      : connectionSeries(db, defs, proxy, 5 * MINUTE).sort((a, b) => amount(b) - amount(a)).slice(0, 10);
    const domains = lane === 'clash' && !quick ? grouped(db, proxy, 'c.host') : [];
    const nodes = lane === 'clash' && !quick ? grouped(db, proxy, defs.leaf, 50) : [];
    const routeDomains = { proxy: domains }, routeNodes = { proxy: nodes };
    if (lane === 'clash' && !quick) for (const route of ['direct','unknown','all']) {
      const selected=route==='all' ? all : filtered(defs,range,{route});
      routeDomains[route]=grouped(db,selected,'c.host');routeNodes[route]=grouped(db,selected,defs.leaf,50);
    }
    const comparison = ['today', 'day'].includes(range.name)
      ? db.prepare(`SELECT COUNT(*) samples,COALESCE(SUM(all_up),0) up,COALESCE(SUM(all_down),0) down
          FROM samples WHERE at>=? AND at<?`).get(range.from - DAY, range.to - DAY) : null;
    db.exec('COMMIT');
    return {
      available: true, lane, detailReady: !quick, range: { ...range, intervalMs: width }, firstAt, lastAt, totals,
      retentionDays: settings(db, 'retentionDays', 0), captureMode: settings(db, 'captureMode', lane === 'windows' ? 'native' : 'mihomo'),
      groups, familyTotals, allPrograms, routePrograms, programs: lane === 'windows' ? allPrograms : routePrograms.proxy,
      domains, nodes, routeDomains, routeNodes,
      timeline, routeTimeline, peaks, comparison, gaps: gapCount, gapDetails,
      coverage: { observedMs: totals.observedMs, expectedMs: range.to - range.from,
        percent: range.to > range.from ? Math.min(100, totals.observedMs / (range.to - range.from) * 100) : null },
      unassigned: { up: Math.max(0, totals.up - connected.up), down: Math.max(0, totals.down - connected.down) },
      connectionCountersExceedGlobal: connected.up > totals.up || connected.down > totals.down,
      queryMs: Math.round(performance.now() - began), cacheWarning,
    };
  } finally { db.close(); }
}

export function readDetail(dataRoot, lane, rangeName, now = Date.now(), options = {}) {
  const began = performance.now(), db = openLane(dataRoot, lane);
  if (!db) return { available: false, error: 'missing_database' };
  try {
    const apps = harnessApps(db, options);
    const { range } = resolveRange(db, rangeName, now, options);
    const defs = definitions(db, apps), candidates = candidateConnections(db, defs, range, options);
    const width = widthFor(range), rawClauses = ['b.minute>=?','b.minute<?'], rawParams = [range.from,range.to];
    if (candidates !== null) { rawClauses.push('b.connection_id IN (SELECT value FROM json_each(?))');rawParams.push(candidates); }
    if (options.scope) { rawClauses.push('b.scope=?');rawParams.push(options.scope); }
    if (options.process === '__unknown__') rawClauses.push("b.scope='unknown'");
    // The main database was opened read-only. Permit private TEMP tables to reduce
    // every summary/page query to a single range scan and one metadata lookup per connection.
    db.exec('PRAGMA query_only=OFF');
    const filter = filtered(defs,range,options);
    db.prepare(      'CREATE TEMP TABLE selected_usage AS WITH events AS MATERIALIZED (SELECT connection_id,scope,SUM(up) up,SUM(down) down,' +
      'MIN(minute) minute,MAX(last_at) last_at,COUNT(DISTINCT minute) minutes FROM buckets b WHERE ' + rawClauses.join(' AND ') + ' GROUP BY connection_id,scope) ' +
      'SELECT c.id,' + defs.name + ' process,' + defs.pid + ' pid,c.host,c.network,b.scope,' + defs.evidence + ' evidence,' + defs.family + ' family,' +
      defs.route + ' route,' + defs.leaf + ' node,b.up,b.down,b.up+b.down amount,b.minute firstAt,b.last_at lastAt,b.minutes,c.rule ' +
      filter.sql.replace('FROM buckets b','FROM events b')
    ).run(...rawParams,...filter.params);
    db.exec('CREATE UNIQUE INDEX selected_identity ON selected_usage(id,scope)');
    const summary = db.prepare('SELECT COALESCE(SUM(up),0) up,COALESCE(SUM(down),0) down,COUNT(DISTINCT id) connections,MIN(firstAt) firstAt,MAX(lastAt) lastAt FROM selected_usage').get();
    const processes = db.prepare('SELECT process,process name,scope,family,evidence,SUM(up) up,SUM(down) down,COUNT(DISTINCT id) connections,MIN(firstAt) firstAt,MAX(lastAt) lastAt FROM selected_usage GROUP BY process,scope,family ORDER BY SUM(up+down) DESC').all().map(row=>({...row,name:row.name || '未识别进程'}));
    const group = (expression,limit=100) => db.prepare('SELECT ' + expression + ' name,SUM(up) up,SUM(down) down,COUNT(DISTINCT id) connections FROM selected_usage GROUP BY 1 ORDER BY SUM(up+down) DESC LIMIT ?').all(limit);
    const destinations = group('host'), nodes = lane === 'clash' ? group('node',50) : [];
    const routes = {proxy:zero(),direct:zero(),unknown:zero()};
    if (lane === 'clash') for (const row of group('route',3)) routes[row.name] = {up:row.up,down:row.down};
    const series = db.prepare(      'SELECT CAST(b.minute / ? AS INTEGER)*? at,SUM(b.up) up,SUM(b.down) down,' +
      "SUM(CASE WHEN u.route='proxy' THEN b.up ELSE 0 END) proxyUp,SUM(CASE WHEN u.route='proxy' THEN b.down ELSE 0 END) proxyDown," +
      "SUM(CASE WHEN u.route='direct' THEN b.up ELSE 0 END) directUp,SUM(CASE WHEN u.route='direct' THEN b.down ELSE 0 END) directDown," +
      "SUM(CASE WHEN u.route='unknown' THEN b.up ELSE 0 END) unknownUp,SUM(CASE WHEN u.route='unknown' THEN b.down ELSE 0 END) unknownDown " +
      'FROM selected_usage u CROSS JOIN buckets b ON b.connection_id=u.id AND b.scope=u.scope WHERE b.minute>=? AND b.minute<? GROUP BY 1 ORDER BY 1'
    ).all(width,width,range.from,range.to).map(row=>({at:row.at,up:row.up,down:row.down,proxy:{up:row.proxyUp,down:row.proxyDown},direct:{up:row.directUp,down:row.directDown},unknown:{up:row.unknownUp,down:row.unknownDown}}));
    const requestedPage = Math.max(0, Math.min(100000, Math.floor(Number(options.page) || 0)));
    const pageSize = options.export === true ? 5000 : 100;
    const connectionCount = db.prepare('SELECT COUNT(*) count FROM selected_usage').get().count;
    const page = Math.min(requestedPage, Math.max(0, Math.ceil(connectionCount / pageSize) - 1));
    const connections = db.prepare('SELECT * FROM selected_usage ORDER BY amount DESC,id LIMIT ? OFFSET ?').all(pageSize,page*pageSize).map(row=>{
      let metadata = {};try {metadata=JSON.parse(row.rule);} catch {}
      const {rule,...connection} = row;
      return {...connection,destinationIP:metadata.destinationIP || '',destinationPort:metadata.destinationPort || 0,localIP:metadata.localIP || '',localPort:metadata.localPort || 0,observedPID:metadata.observedPID || null,chain:metadata.chains || []};
    });
    const timeline = db.prepare('SELECT CAST(at / ? AS INTEGER)*? at,COUNT(*) samples FROM samples WHERE at>=? AND at<? GROUP BY 1 ORDER BY 1').all(width,width,range.from,range.to);
    const gapDetails = db.prepare('SELECT reason,MAX(started_at,?) gapFrom,MIN(COALESCE(ended_at,?),?) gapTo,ended_at IS NULL ongoing FROM collection_gaps WHERE started_at<? AND COALESCE(ended_at,?)>? ORDER BY started_at DESC LIMIT 100').all(range.from,range.to,range.to,range.to,range.to,range.from);
    const observation = {available:true,range:{...range,intervalMs:width},timeline,gapDetails};
    db.exec('COMMIT');
    return {available:true,lane,range:{...range,intervalMs:width},summary,connections,processes,destinations,nodes,series,routeTotals:routes,observation,
      pagination:{page,pageSize,total:connectionCount,pages:Math.ceil(connectionCount/pageSize)},truncated:false,queryMs:Math.round(performance.now()-began)};

  } finally { db.close(); }
}

export function readSavedApps(dataRoot) {
  const db = openLane(dataRoot, 'windows');
  if (!db) return normalizeHarnessApps(null);
  try { return harnessApps(db); } finally { db.close(); }
}

if (parentPort) parentPort.on('message', ({ id, type = 'overview', range, date, now, options = {} }) => {
  try {
    if (type === 'apps') { parentPort.postMessage({ id, data: { apps: readSavedApps(workerData.dataRoot) } }); return; }
    const data = {};
    if (type === 'detail') data.detail = readDetail(workerData.dataRoot, options.lane, range, now, { ...options, cacheRoot: options.lane === 'windows' ? workerData.cacheRoot : undefined });
    else for (const [role, lane] of [['machine', 'windows'], ['clash', 'clash']]) {
      try { data[role] = readLane(workerData.dataRoot, lane, range, now, { ...options, cacheRoot: workerData.cacheRoot, date }); }
      catch (error) { if (error instanceof RangeError) throw error; data[role] = { available: false, error: error.code || 'database_unavailable' }; }
    }
    parentPort.postMessage({ id, data });
  } catch (error) { parentPort.postMessage({ id, error: error instanceof RangeError ? 'invalid_range' : 'database_unavailable' }); }
});

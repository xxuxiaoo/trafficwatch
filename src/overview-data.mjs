import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync,configureDatabaseKeys } from './database.mjs';
import { restrictReadConnection } from './vault-grants.mjs';
import { readLegacy } from './vault-legacy.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { DEFAULT_CODEX_PROCESS_NAMES, normalizeHarnessApps } from './harness.mjs';
import { programRollup } from './history-rollup.mjs';
import { attachArchiveViews, setArchiveWindows, historyBounds } from './history-archive.mjs';

const MINUTE = 60000, DAY = 86400000;
const timeZone = 'Asia/Shanghai';
const zero = () => ({ up: 0, down: 0 });
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
  const firstAt = historyBounds(db).firstAt;
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

function filtered(defs, range, options = {}) {
  const clauses = ['b.minute>=?', 'b.minute<?'];
  const params = [range.from, range.to];
  if (options.family) { clauses.push(`${defs.family}=?`); params.push(options.family); }
  if (options.process === '__unknown__') clauses.push("b.scope='unknown'");
  else if (options.process) { clauses.push(`lower(${defs.name})=?`); params.push(options.process.toLowerCase()); }
  if (options.scope) { clauses.push('b.scope=?'); params.push(options.scope); }
  if (options.host) { clauses.push('c.host=?'); params.push(options.host); }
  if (options.node) { clauses.push(`${defs.leaf}=?`); params.push(options.node); }
  if (options.route && options.route !== 'all') { clauses.push(`${defs.route}=?`); params.push(options.route); }
  return { sql: `${defs.join} WHERE ${clauses.join(' AND ')}`, params };
}

function programs(db, defs, filter, limit = 1000) {
  return db.prepare(`${filter.prefix || ''} SELECT ${defs.name} process,${defs.name} name,b.scope,${defs.family} family,
    ${defs.evidence} evidence,SUM(b.up) up,SUM(b.down) down,COUNT(DISTINCT c.id) connections,
    MIN(b.minute) firstAt,MAX(b.last_at) lastAt ${filter.sql}
    GROUP BY 1,b.scope,4 ORDER BY SUM(b.up+b.down) DESC${limit === null ? '' : ' LIMIT ?'}`).all(...filter.params, ...(limit === null ? [] : [limit]))
    .map((row) => ({ ...row, name: row.name || '未识别进程' }));
}

// Scan the selected minutes once, then resolve metadata once per connection and
// scope. In particular a one-hour click must not scan the lifetime dictionary,
// and route charts must not parse the same rule for every summary and bucket.
function selectUsage(db,defs,range,options={},detail=false){
  const clauses=['minute>=?','minute<?'],params=[range.from,range.to];
  if(options.scope){clauses.push('scope=?');params.push(options.scope);}
  if(options.process==='__unknown__')clauses.push("scope='unknown'");
  db.exec('PRAGMA query_only=OFF;DROP TABLE IF EXISTS temp.selected_usage;DROP TABLE IF EXISTS temp.range_usage');
  db.prepare(`CREATE TEMP TABLE range_usage AS SELECT connection_id,scope,SUM(up) up,SUM(down) down,MIN(minute) minute,MAX(last_at) last_at,COUNT(*) minutes
    FROM buckets WHERE ${clauses.join(' AND ')} GROUP BY connection_id,scope`).run(...params);
  const filter=filtered(defs,range,options);
  db.prepare(`CREATE TEMP TABLE selected_usage AS SELECT c.id,${defs.name} process,${defs.pid} pid,c.host,c.network,b.scope,${defs.evidence} evidence,${defs.family} family,
    ${defs.route} route,${defs.leaf} node,b.up,b.down,b.up+b.down amount,b.minute firstAt,b.last_at lastAt,b.minutes,
    ${detail?`(c.first_seen>=${range.from} AND c.last_seen<${range.to})`:'0'} _lifetime_inside
    ${filter.sql.replace('FROM buckets b','FROM range_usage b')}`).run(...filter.params);
  const selected=detail?db.prepare('SELECT COUNT(*) count,COALESCE(SUM(minutes),0) minutes,MIN(_lifetime_inside) inside FROM selected_usage').get():{},all=detail?db.prepare('SELECT COALESCE(SUM(minutes),0) minutes FROM range_usage').get():{};
  db.exec('CREATE UNIQUE INDEX selected_identity ON selected_usage(id,scope);DROP TABLE temp.range_usage');
  return {empty:selected.count===0,identityFirst:Boolean(selected.inside&&selected.minutes<all.minutes*.35)};
}
function selectedGroups(db,expression,route='',limit=100){
  return db.prepare(`SELECT ${expression} name,SUM(up) up,SUM(down) down,COUNT(DISTINCT id) connections FROM selected_usage${route?' WHERE route=?':''} GROUP BY 1 ORDER BY SUM(up+down) DESC LIMIT ?`).all(...(route?[route]:[]),limit);
}
function selectedPrograms(db,route='',limit=null){
  return db.prepare(`SELECT process,process name,scope,family,evidence,SUM(up) up,SUM(down) down,COUNT(DISTINCT id) connections,MIN(firstAt) firstAt,MAX(lastAt) lastAt
    FROM selected_usage${route?' WHERE route=?':''} GROUP BY process,scope,family ORDER BY SUM(up+down) DESC${limit===null?'':' LIMIT ?'}`).all(...(route?[route]:[]),...(limit===null?[]:[limit])).map(row=>({...row,name:row.name||'未识别进程'}));
}
function selectedRoutes(db){
  const routes={proxy:zero(),direct:zero(),unknown:zero()};
  for(const row of selectedGroups(db,'route','',3))routes[row.name]={up:row.up,down:row.down};return routes;
}
function selectedSeries(db,range,width,route='',plan={}){
  if(plan.empty)return [];
  // Prefer time first: an identity-first join can reread a connection's entire
  // lifetime through its single-column index. A selective detail may use that
  // index only when the selected connections' lifetimes fit the range in full.
  return db.prepare(`SELECT CAST(b.minute / ? AS INTEGER)*? at,SUM(b.up) up,SUM(b.down) down,
    SUM(CASE WHEN u.route='proxy' THEN b.up ELSE 0 END) proxyUp,SUM(CASE WHEN u.route='proxy' THEN b.down ELSE 0 END) proxyDown,
    SUM(CASE WHEN u.route='direct' THEN b.up ELSE 0 END) directUp,SUM(CASE WHEN u.route='direct' THEN b.down ELSE 0 END) directDown,
    SUM(CASE WHEN u.route='unknown' THEN b.up ELSE 0 END) unknownUp,SUM(CASE WHEN u.route='unknown' THEN b.down ELSE 0 END) unknownDown
    ${plan.identityFirst?'FROM selected_usage u CROSS JOIN buckets b':'FROM buckets b CROSS JOIN selected_usage u'} ON u.id=b.connection_id AND u.scope=b.scope WHERE b.minute>=? AND b.minute<?${route?' AND u.route=?':''} GROUP BY 1 ORDER BY 1`)
    .all(width,width,range.from,range.to,...(route?[route]:[])).map(row=>({at:row.at,up:row.up,down:row.down,proxy:{up:row.proxyUp,down:row.proxyDown},direct:{up:row.directUp,down:row.directDown},unknown:{up:row.unknownUp,down:row.unknownDown}}));
}
function selectedCharts(db,range,width){
  const fine=Math.min(width,5*MINUTE);
  db.prepare(`CREATE TEMP TABLE selected_timeline AS SELECT CAST(b.minute / ? AS INTEGER)*? at,SUM(b.up) up,SUM(b.down) down,
    SUM(CASE WHEN u.route='proxy' THEN b.up ELSE 0 END) proxyUp,SUM(CASE WHEN u.route='proxy' THEN b.down ELSE 0 END) proxyDown,
    SUM(CASE WHEN u.route='direct' THEN b.up ELSE 0 END) directUp,SUM(CASE WHEN u.route='direct' THEN b.down ELSE 0 END) directDown,
    SUM(CASE WHEN u.route='unknown' THEN b.up ELSE 0 END) unknownUp,SUM(CASE WHEN u.route='unknown' THEN b.down ELSE 0 END) unknownDown,
    SUM(u.route='proxy') proxyRows FROM buckets b CROSS JOIN selected_usage u ON u.id=b.connection_id AND u.scope=b.scope
    WHERE b.minute>=? AND b.minute<? GROUP BY 1`).run(fine,fine,range.from,range.to);
  const routeTimeline=db.prepare(`SELECT CAST(at / ? AS INTEGER)*? at,SUM(up) up,SUM(down) down,SUM(proxyUp) proxyUp,SUM(proxyDown) proxyDown,
    SUM(directUp) directUp,SUM(directDown) directDown,SUM(unknownUp) unknownUp,SUM(unknownDown) unknownDown FROM selected_timeline GROUP BY 1 ORDER BY 1`).all(width,width)
    .map(row=>({at:row.at,up:row.up,down:row.down,proxy:{up:row.proxyUp,down:row.proxyDown},direct:{up:row.directUp,down:row.directDown},unknown:{up:row.unknownUp,down:row.unknownDown}}));
  const peaks=db.prepare(`SELECT CAST(at / ? AS INTEGER)*? at,SUM(proxyUp) up,SUM(proxyDown) down FROM selected_timeline
    GROUP BY 1 HAVING SUM(proxyRows)>0 ORDER BY SUM(proxyUp+proxyDown) DESC,at LIMIT 10`).all(5*MINUTE,5*MINUTE)
    .map(row=>({...row,proxy:{up:row.up,down:row.down},direct:zero(),unknown:zero()}));
  db.exec('DROP TABLE temp.selected_timeline');return {routeTimeline,peaks};
}

function openLane(dataRoot, lane, options = {}) {
  if (!['windows', 'clash'].includes(lane)) throw new RangeError('Invalid lane');
  if(options.allowedLanes&&!options.allowedLanes.includes(lane))return null;
  const encrypted=options.vault===true||fs.existsSync(path.join(dataRoot,'vault','vault.json'));
  const file = path.join(dataRoot, lane, encrypted?'history.vault.sqlite':'monitor.sqlite');
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA temp_store=MEMORY');
  attachArchiveViews(db,{windows:options.authorizedWindows});
  if(options.authorizedWindows)restrictReadConnection(db,options.authorizedWindows);
  // These settings affect this read-only connection only. Keep grouping work in
  // memory and avoid thrashing SQLite's default 2 MiB cache on metadata joins.
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=600; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768; BEGIN');
  return db;
}

export function readLane(dataRoot, lane, rangeName, now = Date.now(), options = {}) {
  const report=stage=>options.report?.({stage,lane});report('opening');
  const began = performance.now(), db = openLane(dataRoot, lane,options);
  if (!db) return { available: false, error: 'missing_database' };
  try {
    const apps = harnessApps(db, options);
    const { firstAt, range } = resolveRange(db, rangeName, now, options);
    const lastAt = historyBounds(db).lastAt;
    setArchiveWindows(db,[{from:Math.max(0,range.from-(['today','day'].includes(range.name)?DAY:0)),to:range.to}]);
    const width = widthFor(range), defs = definitions(db, apps), all = filtered(defs, range);
    report('totals');
    const totals = db.prepare(`SELECT COUNT(*) samples,MIN(at) firstAt,MAX(at) lastAt,
      COALESCE(SUM(all_up),0) up,COALESCE(SUM(all_down),0) down,
      COALESCE(SUM(CASE WHEN duration>0 AND duration<=2000 THEN
        MAX(0,MIN(at,?)-MAX(at-duration,?)) ELSE 0 END),0) observedMs
      FROM samples WHERE at>=? AND at<?`).get(range.to, range.from, range.from, range.to);
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
    report('programs');
    const quick = options.quick === true;
    if(lane==='clash')selectUsage(db,defs,range);
    if (!quick && lane === 'windows' && options.cacheRoot && !options.skipRollup) {
      try { rolled = programRollup(db, options.cacheRoot, range, totals.firstAt, now, defs, (cache,filter)=>programs(cache,defs,filter,null)); }
      catch { cacheWarning = 'summary_cache_unavailable'; }
    }
    let completePrograms;
    try {
      completePrograms = quick ? [] : lane==='clash'?selectedPrograms(db):rolled?.rows || (rolled ? programs(rolled.db, defs, {
        ...rolled.filter, sql: `FROM usage b ${defs.metadataJoin}`,
      }, null) : programs(db, defs, programFilter, null));
    } finally { rolled?.db.close(); }
    const allPrograms = completePrograms.slice(0, 1000), connected = zero(), familyTotals = {};
    for (const row of completePrograms) {
      connected.up += row.up; connected.down += row.down;
      const family = familyTotals[row.family] ||= zero();
      family.up += row.up; family.down += row.down;
    }
    report('routes');
    const groups = lane === 'clash' ? selectedRoutes(db) : { proxy: zero(), direct: zero(), unknown: zero() };
    const routePrograms = {};
    if (lane === 'clash' && !quick) {
      for (const route of ['proxy', 'direct', 'unknown']) routePrograms[route] = selectedPrograms(db,route,1000);
    }
    report('timeline');
    const timeline = db.prepare(`SELECT CAST(at / ? AS INTEGER)*? at,SUM(all_up) up,SUM(all_down) down,
      COUNT(*) samples FROM samples WHERE at>=? AND at<? GROUP BY 1 ORDER BY 1`).all(width, width, range.from, range.to);
    const charts=lane==='clash'?selectedCharts(db,range,width):null,routeTimeline=charts?.routeTimeline||[];
    const peaks = lane === 'windows'
      ? db.prepare(`SELECT CAST(at / ? AS INTEGER)*? at,SUM(all_up) up,SUM(all_down) down,COUNT(*) samples
          FROM samples WHERE at>=? AND at<? GROUP BY 1 ORDER BY SUM(all_up+all_down) DESC LIMIT 10`)
        .all(5 * MINUTE, 5 * MINUTE, range.from, range.to)
      : charts.peaks;
    const domains = lane === 'clash' && !quick ? selectedGroups(db,'host','proxy') : [];
    const nodes = lane === 'clash' && !quick ? selectedGroups(db,'node','proxy',50) : [];
    const routeDomains = { proxy: domains }, routeNodes = { proxy: nodes };
    if (lane === 'clash' && !quick) for (const route of ['direct','unknown','all']) {
      routeDomains[route]=selectedGroups(db,'host',route==='all'?'':route);routeNodes[route]=selectedGroups(db,'node',route==='all'?'':route,50);
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
  const report=stage=>options.report?.({stage,lane});report('opening');
  const began = performance.now(), db = openLane(dataRoot, lane,options);
  if (!db) return { available: false, error: 'missing_database' };
  try {
    const apps = harnessApps(db, options);
    const { range } = resolveRange(db, rangeName, now, options);
    setArchiveWindows(db,[{from:range.from,to:range.to}]);
    report('selection');const defs = definitions(db, apps),width=widthFor(range),plan=selectUsage(db,defs,range,options,true);
    report('summary');
    const summary = db.prepare('SELECT COALESCE(SUM(up),0) up,COALESCE(SUM(down),0) down,COUNT(DISTINCT id) connections,MIN(firstAt) firstAt,MAX(lastAt) lastAt FROM selected_usage').get();
    const processes=selectedPrograms(db),destinations=selectedGroups(db,'host'),nodes=lane==='clash'?selectedGroups(db,'node','',50):[];
    report('timeline');const routes=lane==='clash'?selectedRoutes(db):{proxy:zero(),direct:zero(),unknown:zero()},series=selectedSeries(db,range,width,'',plan);
    const requestedPage = Math.max(0, Math.min(100000, Math.floor(Number(options.page) || 0)));
    const pageSize = options.export === true ? 5000 : 100;
    const connectionCount = db.prepare('SELECT COUNT(*) count FROM selected_usage').get().count;
    const page = Math.min(requestedPage, Math.max(0, Math.ceil(connectionCount / pageSize) - 1));
    // Keep long rule JSON out of the all-result TEMP tables. Resolve it only
    // after pagination, so 100 visible rows never copy every selected payload.
    report('connections');const connections = db.prepare(`WITH page AS MATERIALIZED (SELECT * FROM selected_usage ORDER BY amount DESC,id LIMIT ? OFFSET ?)
      SELECT page.*,c.rule FROM page CROSS JOIN connections c ON c.id=page.id ORDER BY page.amount DESC,page.id`).all(pageSize,page*pageSize).map(row=>{
      let metadata = {};try {metadata=JSON.parse(row.rule);} catch {}
      const {rule,_lifetime_inside,...connection} = row;
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

if(workerData?.keyEntries)configureDatabaseKeys(workerData.keyEntries);
if (parentPort) parentPort.on('message', ({ id, type = 'overview', range, date, now, options = {} }) => {
  if(options.authorizedWindows)options={...options,cacheRoot:undefined};
  const queryCache=options.authorizedWindows||options.skipRollup?undefined:workerData.cacheRoot;
  try {
    if (type === 'apps') { parentPort.postMessage({ id, data: { apps: readSavedApps(workerData.dataRoot) } }); return; }
    if(type==='legacy'){
      const db=openLane(workerData.dataRoot,options.lane);
      if(!db)throw new Error('database_unavailable');
      try{parentPort.postMessage({id,data:readLegacy(db,options.route,options.params,options.live,now)});}finally{db.close();}return;
    }
    const data = {};
    if (type === 'detail') data.detail = readDetail(workerData.dataRoot, options.lane, range, now, { ...options, cacheRoot: options.lane === 'windows' ? queryCache : undefined,report:progress=>parentPort.postMessage({id,event:'progress',...progress}) });
    else for (const [role, lane] of [['machine', 'windows'], ['clash', 'clash']]) {
      try { data[role] = readLane(workerData.dataRoot, lane, range, now, { ...options, cacheRoot:queryCache, date,report:progress=>parentPort.postMessage({id,event:'progress',...progress}) }); }
      catch (error) { if (error instanceof RangeError) throw error; data[role] = { available: false, error: error.code || 'database_unavailable' }; }
    }
    parentPort.postMessage({ id, data });
  } catch (error) { parentPort.postMessage({ id, error: error instanceof RangeError ? 'invalid_range' : 'database_unavailable' }); }
});

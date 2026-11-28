import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from './database.mjs';
import { historyDirectory, historyFilename } from './history-paths.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import {
  ANTIGRAVITY_BUNDLE_ROOT, DEFAULT_CODEX_PROCESS_NAMES, HARNESS_FAMILIES, isHarnessFamily, normalizeHarnessApps,
} from './harness.mjs';
import { programRollup } from './history-rollup.mjs';
import { attachArchiveViews, archiveIntersects, setArchiveWindows, historyBounds } from './history-archive.mjs';
import { airportGroupKey, normalizeAirportLabel } from './proxy-airports.mjs';

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
  for (const family of HARNESS_FAMILIES) {
    if (apps[family].length) familyCases.push(`WHEN lower(c.process) IN (${apps[family].map(literal).join(',')}) THEN '${family}'`);
  }
  if (hasFamily) {
    for (const family of HARNESS_FAMILIES) {
      const roots = [family === 'antigravity' ? ANTIGRAVITY_BUNDLE_ROOT : `script:${family}`, ...apps[family]];
      familyCases.push(`WHEN f.family='${family}' AND f.root_process IN (${roots.map(literal).join(',')}) THEN '${family}'`);
    }
  }
  const family = `CASE ${familyCases.join(' ')} ELSE 'other' END`;
  const leaf = "CASE WHEN json_valid(c.rule) THEN COALESCE(json_extract(c.rule,'$.chains[0]'),'') ELSE '' END";
  const client = "CASE WHEN json_valid(c.rule) THEN CASE lower(COALESCE(json_extract(c.rule,'$.client'),'')) WHEN 'verge' THEN 'verge' WHEN 'flclash' THEN 'flclash' WHEN 'flclssh' THEN 'flclash' WHEN 'mihomo' THEN 'mihomo' ELSE 'legacy' END ELSE 'legacy' END";
  const autoAirportName = `CASE WHEN json_valid(c.rule) THEN CASE
    WHEN json_extract(c.rule,'$.airport.id') GLOB 'auto-*' AND length(json_extract(c.rule,'$.airport.id'))=29
    THEN COALESCE(json_extract(c.rule,'$.airport.name'),'') ELSE '' END ELSE '' END`;
  const autoAirportKey = `trafficwatch_airport_key(${autoAirportName})`;
  const route = `CASE WHEN NOT json_valid(c.rule) THEN 'unknown'
    WHEN COALESCE(json_extract(c.rule,'$.source'),'')<>'mihomo' THEN 'unknown'
    WHEN upper(trim(${leaf}))='DIRECT' THEN 'direct'
    WHEN upper(trim(${leaf})) IN ('','REJECT','REJECT-DROP','PASS','COMPATIBLE') THEN 'unknown'
    ELSE 'proxy' END`;
  return {
    name, family, route, leaf, client, airportKey: autoAirportKey, autoAirportName, apps, hasFamily,
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
  if (options.client && options.client !== 'all') { clauses.push(`${defs.client}=?`); params.push(options.client); }
  if (options.airport === '__unassigned__') clauses.push(`${defs.route}='proxy' AND ${defs.airportKey}=''`);
  else if (options.airport) { clauses.push(`${defs.route}='proxy' AND ${defs.airportKey}=?`); params.push(options.airport); }
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

function sourcePrograms(db,defs,range,options){
  const report=progress=>options.report?.({lane:'windows',...progress});
  report({stage:'program_buckets'});
  db.exec('PRAGMA query_only=OFF;DROP TABLE IF EXISTS temp.program_usage');
  db.prepare(`CREATE TEMP TABLE program_usage AS SELECT connection_id,scope,SUM(up) up,SUM(down) down,
    MIN(minute) minute,MAX(last_at) last_at FROM buckets WHERE minute>=? AND minute<? GROUP BY connection_id,scope`).run(range.from,range.to);
  const count=db.prepare('SELECT COUNT(*) count FROM temp.program_usage').get().count;
  // Range first is essential: the planner may otherwise scan the lifetime
  // dictionary.
  const covering=db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='index' AND name='connections_programs'").get();
  const rows=db.prepare(`SELECT ${defs.name} process,b.scope,${defs.family} family,${defs.evidence} evidence,
    b.up,b.down,b.minute firstAt,b.last_at lastAt FROM temp.program_usage b
    CROSS JOIN connections c ${covering?'INDEXED BY connections_programs ':''}ON c.id=b.connection_id
    ${defs.hasFamily?'LEFT JOIN connection_families f ON f.connection_id=c.id':''}`);
  const grouped=new Map();let done=0,lastReport=performance.now();
  report({stage:'programs',done,total:count,unit:'identities'});
  for(const row of rows.iterate()){
    const identity=JSON.stringify([row.process,row.scope,row.family]),previous=grouped.get(identity);
    if(previous){previous.up+=row.up;previous.down+=row.down;previous.connections++;previous.firstAt=Math.min(previous.firstAt,row.firstAt);previous.lastAt=Math.max(previous.lastAt,row.lastAt);}
    else grouped.set(identity,{...row,name:row.process||'未识别进程',connections:1});
    done++;
    if(done%1024===0&&performance.now()-lastReport>=200){report({stage:'programs',done,total:count,unit:'identities'});lastReport=performance.now();}
  }
  report({stage:'programs',done,total:count,unit:'identities'});
  db.exec('DROP TABLE temp.program_usage');
  return [...grouped.values()].sort((a,b)=>(b.up+b.down)-(a.up+a.down)||JSON.stringify([a.process,a.scope,a.family]).localeCompare(JSON.stringify([b.process,b.scope,b.family]),'en'));
}

// Scan the selected minutes once, then resolve metadata once per connection and
// scope. In particular a one-hour click must not scan the lifetime dictionary,
// and route charts must not parse the same rule for every summary and bucket.
function selectUsage(db,defs,range,options={},detail=false,compact=false){
  const clauses=['minute>=?','minute<?'],params=[range.from,range.to];
  if(options.scope){clauses.push('scope=?');params.push(options.scope);}
  if(options.process==='__unknown__')clauses.push("scope='unknown'");
  else if (options.process && /^[\x20-\x7e]+$/.test(options.process)) {
    // Process-filtered details need only the selected identities. This is
    // particularly important when a whole day spans millions of ETW buckets.
    clauses.push("scope<>'unknown' AND connection_id IN (SELECT id FROM main.connections WHERE process=? COLLATE NOCASE)");
    params.push(options.process);
  }
  db.exec('PRAGMA query_only=OFF;DROP TABLE IF EXISTS temp.selected_usage;DROP TABLE IF EXISTS temp.range_usage');
  db.prepare(`CREATE TEMP TABLE range_usage AS SELECT connection_id,scope,SUM(up) up,SUM(down) down,MIN(minute) minute,MAX(last_at) last_at,COUNT(*) minutes
    FROM buckets WHERE ${clauses.join(' AND ')} GROUP BY connection_id,scope`).run(...params);
  const filter=filtered(defs,range,options);
  const covering=compact&&options.lane==='windows'&&db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='index' AND name='connections_programs'").get();
  let source=filter.sql.replace('FROM buckets b','FROM range_usage b');
  if(compact)source=source.replace('JOIN connections c ON',`CROSS JOIN connections c ${covering?'INDEXED BY connections_programs ':''}ON`);
  const airportColumns=options.lane==='windows'?"'' airport,NULL airport_name":`${defs.airportKey} airport,${defs.autoAirportName} airport_name`;
  const clientColumn=options.lane==='windows'?"'legacy'":defs.client;
  db.prepare(`CREATE TEMP TABLE selected_usage AS SELECT c.id,${defs.name} process,${compact?'':`${defs.pid} pid,c.host,c.network,`}b.scope,${defs.evidence} evidence,${defs.family} family,
    ${compact&&options.lane==='windows'?"'unknown'":defs.route} route,${clientColumn} client,${airportColumns},${compact?'':`${defs.leaf} node,`}b.up,b.down,b.up+b.down amount,b.minute firstAt,b.last_at lastAt,b.minutes,
    ${detail?`(c.first_seen>=${range.from} AND c.last_seen<${range.to})`:'0'} _lifetime_inside
    ${source}`).run(...filter.params);
  const selected=detail?db.prepare('SELECT COUNT(*) count,COALESCE(SUM(minutes),0) minutes,MIN(_lifetime_inside) inside FROM selected_usage').get():{},all=detail?db.prepare('SELECT COALESCE(SUM(minutes),0) minutes FROM range_usage').get():{};
  db.exec('CREATE UNIQUE INDEX selected_identity ON selected_usage(id,scope);DROP TABLE temp.range_usage');
  return {empty:selected.count===0,identityFirst:Boolean(selected.inside&&selected.minutes<all.minutes*.35)};
}
function selectedGroups(db,expression,route='',limit=100){
  return db.prepare(`SELECT ${expression} name,SUM(up) up,SUM(down) down,COUNT(DISTINCT id) connections FROM selected_usage${route?' WHERE route=?':''} GROUP BY 1 ORDER BY SUM(up+down) DESC LIMIT ?`).all(...(route?[route]:[]),limit);
}
function airportRows(db){
  const rows=db.prepare(`SELECT client,airport,MAX(airport_name) airportName,SUM(up) up,SUM(down) down,
    COUNT(DISTINCT id) connections,MIN(firstAt) firstAt,MAX(lastAt) lastAt
    FROM selected_usage WHERE route='proxy' GROUP BY airport,client ORDER BY SUM(up+down) DESC,client`).all();
  const groups=new Map();
  for(const row of rows){
    const label=normalizeAirportLabel(row.airportName);
    const key=row.airport||'__unassigned__';
    let group=groups.get(key);
    if(!group){group={airport:key,airportName:label,up:0,down:0,connections:0,firstAt:row.firstAt,lastAt:row.lastAt,clients:[]};groups.set(key,group);}
    group.up+=row.up;group.down+=row.down;group.connections+=row.connections;
    group.firstAt=Math.min(group.firstAt,row.firstAt);group.lastAt=Math.max(group.lastAt,row.lastAt);
    group.clients.push({client:row.client,up:row.up,down:row.down,connections:row.connections});
  }
  return [...groups.values()].sort((a,b)=>(b.up+b.down)-(a.up+a.down)||a.airport.localeCompare(b.airport,'en'));
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
  if(options.singleCollector&&(options.singleCollector==='mihomo'?lane==='windows':lane==='clash'))return null;
  const file = path.join(historyDirectory(dataRoot, lane, options), historyFilename(lane));
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  if (lane === 'clash') db.function('trafficwatch_airport_key', { deterministic: true }, airportGroupKey);
  db.exec('PRAGMA temp_store=MEMORY');
  attachArchiveViews(db);
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
    const width = widthFor(range);
    const defs = definitions(db, apps);
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
    const anomalies = db.prepare(`SELECT kind, started_at AS startedAt, ended_at AS endedAt,
      json_extract(detail,'$.bytes') AS bytes, json_extract(detail,'$.process') AS process
      FROM anomalies WHERE ended_at>=? AND ended_at<? AND json_valid(detail)
      ORDER BY ended_at DESC LIMIT 3`).all(range.from,range.to);
    let rolled, cacheWarning;
    report('programs');
    const quick = options.quick === true;
    if(lane==='clash')selectUsage(db,defs,range,{...options,lane});
    if (!quick && lane === 'windows' && options.cacheRoot ) {
      try { rolled = programRollup(db, options.cacheRoot, range, totals.firstAt, now, defs, (cache,filter)=>programs(cache,defs,filter,null)); }
      catch { cacheWarning = 'summary_cache_unavailable'; }
    }
    let completePrograms;
    try {
      completePrograms = quick ? [] : lane==='clash'?selectedPrograms(db):rolled?.rows || (rolled ? programs(rolled.db, defs, {
        ...rolled.filter, sql: `FROM usage b ${defs.metadataJoin}`,
      }, null) : sourcePrograms(db,defs,range,options));
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
    const airportUsage=lane==='clash'?airportRows(db):[];
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
      domains, nodes, routeDomains, routeNodes,airportUsage,
      timeline, routeTimeline, peaks, comparison, gaps: gapCount, gapDetails, anomalies,
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
    report('selection');const defs = definitions(db, apps),width=widthFor(range),plan=selectUsage(db,defs,range,{...options,lane},true);
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
      SELECT page.*,CASE WHEN json_valid(c.rule) THEN c.rule END metadata FROM page CROSS JOIN connections c ON c.id=page.id ORDER BY page.amount DESC,page.id`).all(pageSize,page*pageSize).map(row=>{
      const {metadata:raw,_lifetime_inside,airport_name:airportName,...connection} = row;
      const metadata = raw ? JSON.parse(raw) ?? {} : {};
      return {...connection,...(airportName?{airportName:normalizeAirportLabel(airportName)}:{}),destinationIP:metadata.destinationIP || '',destinationPort:metadata.destinationPort || 0,localIP:metadata.localIP || '',localPort:metadata.localPort || 0,observedPID:metadata.observedPID || null,chain:metadata.chains || []};
    });
    const timeline = db.prepare('SELECT CAST(at / ? AS INTEGER)*? at,COUNT(*) samples FROM samples WHERE at>=? AND at<? GROUP BY 1 ORDER BY 1').all(width,width,range.from,range.to);
    const gapDetails = db.prepare('SELECT reason,MAX(started_at,?) gapFrom,MIN(COALESCE(ended_at,?),?) gapTo,ended_at IS NULL ongoing FROM collection_gaps WHERE started_at<? AND COALESCE(ended_at,?)>? ORDER BY started_at DESC LIMIT 100').all(range.from,range.to,range.to,range.to,range.to,range.from);
    const observation = {available:true,range:{...range,intervalMs:width},timeline,gapDetails};
    db.exec('COMMIT');
    return {available:true,lane,range:{...range,intervalMs:width},summary,connections,processes,destinations,nodes,series,routeTotals:routes,observation,
      pagination:{page,pageSize,total:connectionCount,pages:Math.ceil(connectionCount/pageSize)},truncated:false,queryMs:Math.round(performance.now()-began)};

  } finally { db.close(); }
}

function hasMainIndex(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='index' AND name=?").get(name));
}

function selectWindowsHarnessFast(db, defs, range, family) {
  const names = defs.apps[family] || [];
  if (!names.every((name) => /^[\x20-\x7e]+$/.test(name))) return false;
  if (!hasMainIndex(db, 'connections_process_name')) return false;
  if (defs.hasFamily && !hasMainIndex(db, 'connection_families_family')) return false;
  db.exec('PRAGMA query_only=OFF;DROP TABLE IF EXISTS temp.family_candidates;DROP TABLE IF EXISTS temp.family_buckets;DROP TABLE IF EXISTS temp.selected_usage');
  db.exec('CREATE TEMP TABLE family_candidates(id TEXT PRIMARY KEY) WITHOUT ROWID');
  if (names.length) {
    db.exec(`INSERT OR IGNORE INTO temp.family_candidates(id) SELECT id FROM main.connections WHERE process COLLATE NOCASE IN (${names.map(literal).join(',')})`);
  }
  if (defs.hasFamily) {
    db.prepare('INSERT OR IGNORE INTO temp.family_candidates(id) SELECT connection_id FROM main.connection_families WHERE family=?').run(family);
  }
  const candidates = db.prepare('SELECT COUNT(*) count FROM temp.family_candidates').get().count;
  const byConnection = family !== 'codex' && !archiveIntersects(db, range) && candidates <= 20000
    && (range.to - range.from) > 2 * DAY && hasMainIndex(db, 'buckets_connection');
  if (byConnection) {
    db.prepare(`CREATE TEMP TABLE family_buckets AS
      SELECT b.minute,b.connection_id,b.scope,b.up,b.down,b.last_at
      FROM temp.family_candidates fc
      CROSS JOIN main.buckets b INDEXED BY buckets_connection ON b.connection_id=fc.id
      WHERE b.minute>=? AND b.minute<? AND b.scope<>'unknown' AND b.scope<>'codex'`).run(range.from, range.to);
  } else {
    const scopeFilter = family === 'codex'
      ? "(b.scope='codex' OR (b.scope<>'unknown' AND EXISTS(SELECT 1 FROM temp.family_candidates fc WHERE fc.id=b.connection_id)))"
      : "(b.scope<>'unknown' AND b.scope<>'codex' AND EXISTS(SELECT 1 FROM temp.family_candidates fc WHERE fc.id=b.connection_id))";
    db.prepare(`CREATE TEMP TABLE family_buckets AS
      SELECT b.minute,b.connection_id,b.scope,b.up,b.down,b.last_at
      FROM buckets b
      WHERE b.minute>=? AND b.minute<? AND ${scopeFilter}`).run(range.from, range.to);
  }
  const covering = hasMainIndex(db, 'connections_programs');
  db.prepare(`CREATE TEMP TABLE selected_usage AS
    SELECT c.id,${defs.name} process,b.scope,${defs.evidence} evidence,${defs.family} family,
      'unknown' route,'legacy' client,'' airport,NULL airport_name,
      b.up,b.down,b.up+b.down amount,b.minute firstAt,b.last_at lastAt,b.minutes,0 _lifetime_inside
    FROM (SELECT connection_id,scope,SUM(up) up,SUM(down) down,MIN(minute) minute,MAX(last_at) last_at,COUNT(*) minutes
      FROM temp.family_buckets GROUP BY connection_id,scope) b
    CROSS JOIN connections c ${covering ? 'INDEXED BY connections_programs ' : ''}ON c.id=b.connection_id
    ${defs.hasFamily ? 'LEFT JOIN connection_families f ON f.connection_id=c.id' : ''}
    WHERE ${defs.family}=?`).run(family);
  db.exec('CREATE UNIQUE INDEX selected_identity ON selected_usage(id,scope);DROP TABLE temp.family_candidates');
  return true;
}

// Harness needs a chart and a process list, not destinations, rule payloads or
// connection pages. Keep the Windows join inside the covering
// index, even when the lifetime dictionary contains multi-kilobyte rules.
export function readHarness(dataRoot,lane,rangeName,now=Date.now(),options={}){
  if (!isHarnessFamily(options.family)) throw new RangeError('Invalid family');
  const began=performance.now(),db=openLane(dataRoot,lane,options);
  if(!db)return {available:false,error:'missing_database'};
  const report=value=>options.report?.({lane,...value});
  try{
    const apps=harnessApps(db,options),{range}=resolveRange(db,rangeName,now,options),width=widthFor(range),defs=definitions(db,apps);
    setArchiveWindows(db,[{from:range.from,to:range.to}]);report({stage:'program_buckets'});
    const singlePass = lane === 'windows' && selectWindowsHarnessFast(db, defs, range, options.family);
    if (!singlePass) selectUsage(db,defs,range,{...options,lane,route:lane==='clash'?'proxy':'all'},false,true);
    // SQL counts identities rather than retaining a JS Set per connection and
    // chart bucket. Long date ranges therefore do not grow the worker's heap
    // with every distinct connection in a selected family.
    report({stage:'summary'});
    const summary=db.prepare('SELECT COALESCE(SUM(up),0) up,COALESCE(SUM(down),0) down,COUNT(DISTINCT id) connections,MIN(firstAt) firstAt,MAX(lastAt) lastAt FROM selected_usage').get();
    const processes=selectedPrograms(db),routeTotals=lane==='clash'?selectedRoutes(db):{proxy:zero(),direct:zero(),unknown:zero()};
    report({stage:'timeline'});
    let series;
    if (singlePass) {
      series = !summary.connections ? [] : db.prepare(`SELECT CAST(b.minute / ? AS INTEGER)*? at,SUM(b.up) up,SUM(b.down) down
        FROM temp.family_buckets b JOIN temp.selected_usage u ON u.id=b.connection_id AND u.scope=b.scope
        GROUP BY 1 ORDER BY 1`).all(width, width)
        .map(row => ({ at: row.at, up: row.up, down: row.down, proxy: zero(), direct: zero(), unknown: { up: row.up, down: row.down } }));
      db.exec('DROP TABLE temp.family_buckets');
    } else {
      series=selectedSeries(db,range,width,'',{empty:!summary.connections});
    }
    const observationTimeline=db.prepare('SELECT CAST(at / ? AS INTEGER)*? at,COUNT(*) samples FROM samples WHERE at>=? AND at<? GROUP BY 1 ORDER BY 1').all(width,width,range.from,range.to);
    const gapDetails=db.prepare('SELECT reason,MAX(started_at,?) gapFrom,MIN(COALESCE(ended_at,?),?) gapTo,ended_at IS NULL ongoing FROM collection_gaps WHERE started_at<? AND COALESCE(ended_at,?)>? ORDER BY started_at DESC LIMIT 100').all(range.from,range.to,range.to,range.to,range.to,range.from);
    db.exec('COMMIT');
    const outputRange={...range,intervalMs:width};
    return {available:true,lane,range:outputRange,summary,routeTotals,series,processes,
      observation:{available:true,range:outputRange,timeline:observationTimeline,gapDetails},queryMs:Math.round(performance.now()-began)};
  }finally{db.close();}
}

export function readLadder(dataRoot,rangeName,now=Date.now(),options={}){
  const lane='clash',began=performance.now(),db=openLane(dataRoot,lane,options);
  if(!db)return {available:false,error:'missing_database'};
  const report=stage=>options.report?.({stage,lane});
  try{
    const {range}=resolveRange(db,rangeName,now,options),defs=definitions(db,harnessApps(db,options)),width=widthFor(range);
    setArchiveWindows(db,[{from:range.from,to:range.to}]);report('selection');selectUsage(db,defs,range,{...options,lane});
    report('summary');const summary=db.prepare('SELECT COALESCE(SUM(up),0) up,COALESCE(SUM(down),0) down,COUNT(DISTINCT id) connections,MIN(firstAt) firstAt,MAX(lastAt) lastAt FROM selected_usage').get();
    const routeTotals=selectedRoutes(db),allPrograms=selectedPrograms(db,'',1000),routePrograms={},routeDomains={},routeNodes={};
    for(const route of ['proxy','direct','unknown']){
      routePrograms[route]=selectedPrograms(db,route,1000);routeDomains[route]=selectedGroups(db,'host',route,100);routeNodes[route]=selectedGroups(db,'node',route,200);
    }
    report('timeline');const charts=selectedCharts(db,range,width),airportUsage=airportRows(db),nodes=routeNodes.proxy,domains=routeDomains.proxy;
    const timeline=db.prepare('SELECT CAST(at / ? AS INTEGER)*? at,COUNT(*) samples FROM samples WHERE at>=? AND at<? GROUP BY 1 ORDER BY 1').all(width,width,range.from,range.to);
    const gapDetails=db.prepare('SELECT reason,MAX(started_at,?) gapFrom,MIN(COALESCE(ended_at,?),?) gapTo,ended_at IS NULL ongoing FROM collection_gaps WHERE started_at<? AND COALESCE(ended_at,?)>? ORDER BY started_at DESC LIMIT 100').all(range.from,range.to,range.to,range.to,range.to,range.from);
    const bounds=historyBounds(db);
    db.exec('COMMIT');
    return {available:true,lane,detailReady:true,range:{...range,intervalMs:width},firstAt:bounds.firstAt,lastAt:bounds.lastAt,summary,timeline,gapDetails,groups:routeTotals,allPrograms,routePrograms,programs:routePrograms.proxy,
      routeTotals,routeTimeline:charts.routeTimeline,peaks:charts.peaks,domains,nodes,routeDomains,routeNodes,airportUsage,
      unassigned:null,connectionCountersExceedGlobal:false,queryMs:Math.round(performance.now()-began)};
  }finally{db.close();}
}

export function readSavedApps(dataRoot, options) {
  const db = openLane(dataRoot, options?.singleCollector==='mihomo'?'clash':'windows', options);
  if (!db) return normalizeHarnessApps(null);
  try { return harnessApps(db); } finally { db.close(); }
}
if (parentPort) parentPort.on('message', ({ id, type = 'overview', range, date, now, options = {},client,airport }) => {
  if(workerData.singleCollector)options={...options,singleCollector:workerData.singleCollector};
  if(client!==undefined||airport!==undefined)options={...options,...(client!==undefined?{client}:{}),...(airport!==undefined?{airport}:{})};
  const queryCache=workerData.cacheRoot;
  try {
    if (type === 'apps') { parentPort.postMessage({ id, data: { apps: readSavedApps(workerData.dataRoot,options) } }); return; }
    const data = {};
    if (type === 'detail' || type === 'harness' || type === 'ladder') data.detail = type==='ladder'?readLadder(workerData.dataRoot,range,now,{...options,report:progress=>parentPort.postMessage({id,event:'progress',...progress})}):(type==='harness'?readHarness:readDetail)(workerData.dataRoot, options.lane, range, now, { ...options, cacheRoot: options.lane === 'windows' ? queryCache : undefined,report:progress=>parentPort.postMessage({id,event:'progress',...progress}) });
    else for (const [role, lane] of [['machine', 'windows'], ['clash', 'clash']]) {
      try { data[role] = readLane(workerData.dataRoot, lane, range, now, { ...options, cacheRoot:queryCache, date,report:progress=>parentPort.postMessage({id,event:'progress',...progress}) }); }
      catch (error) { if (error instanceof RangeError) throw error; data[role] = { available: false, error: error.code || 'database_unavailable' }; }
    }
    parentPort.postMessage({ id, data });
  } catch (error) { parentPort.postMessage({ id, error: error instanceof RangeError ? 'invalid_range' : 'database_unavailable' }); }
});

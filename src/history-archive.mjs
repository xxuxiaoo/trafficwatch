import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const DAY = 86400000, MAX_RAW = 1024 * 1024, READ_CACHE = 8 * 1024 * 1024;
const states = new WeakMap();
const replayStatements = new WeakMap();
const replaySampleCaches = new WeakMap();
const REPLAY_CACHE = 4 * 1024 * 1024;
const sampleColumns = ['at','duration','codex_up','codex_down','all_up','all_down','unknown_up','unknown_down','candidates'];
const bucketColumns = ['minute','scope','up','down','last_at'];
const monthAt = at => new Date(at + 8 * 3600000).toISOString().slice(0,7);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hasArchives = db => Boolean(db.prepare("SELECT 1 FROM main.sqlite_master WHERE name='vault_archive_chunks'").get());

// The compressed blocks live in the history database. Moving rows and
// publishing their verified replacement is one SQLite transaction, including
// under abrupt worker termination. No plaintext staging files or second copy of
// the connection/rule dictionary is required.
export function initializeArchives(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS vault_archive_chunks (
    id INTEGER PRIMARY KEY,kind TEXT NOT NULL,month TEXT NOT NULL,group_key TEXT NOT NULL,
    start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,row_count INTEGER NOT NULL,
    raw_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,payload BLOB NOT NULL,
    up INTEGER NOT NULL,down INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS archive_time ON vault_archive_chunks(kind,start_at,end_at);
    CREATE INDEX IF NOT EXISTS archive_end ON vault_archive_chunks(kind,end_at,start_at);
    CREATE INDEX IF NOT EXISTS archive_identity ON vault_archive_chunks(kind,group_key,start_at);
    CREATE INDEX IF NOT EXISTS archive_month ON vault_archive_chunks(month,kind);`);
  // A new envelope can replay an already archived timestamp with a different id.
  // Store.record checks this index before adding any daily or connection bytes.
  store.archivedSampleExists = at => archivedSampleExists(store.db, at);
}

function unpack(chunk) {
  const raw = inflateSync(chunk.payload, { maxOutputLength: MAX_RAW });
  if (raw.length !== chunk.raw_bytes || digest(raw) !== chunk.sha256) throw new Error('archive_corrupt');
  const rows = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(rows) || rows.length !== chunk.row_count) throw new Error('archive_corrupt');
  return { rows, json: raw.toString('utf8') };
}
function encode(rows) {
  const raw = Buffer.from(JSON.stringify(rows));
  if (raw.length > MAX_RAW) throw new Error('archive_block_too_large');
  const payload = deflateSync(raw, { level: 6 });
  const chunk = { payload, raw_bytes: raw.length, sha256: digest(raw), row_count: rows.length };
  // Verify the actual stored representation before deleting a single source row.
  unpack(chunk);
  return chunk;
}
function insertChunk(db, kind, group, rows) {
  const columns = kind === 'samples' ? sampleColumns : bucketColumns;
  const values = rows.map(row => columns.map(column => row[column]));
  const chunk = encode(values), time = kind === 'samples' ? 'at' : 'minute';
  const up = kind === 'samples' ? 'all_up' : 'up', down = kind === 'samples' ? 'all_down' : 'down';
  db.prepare('INSERT INTO vault_archive_chunks(kind,month,group_key,start_at,end_at,row_count,raw_bytes,sha256,payload,up,down) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(kind, monthAt(rows[0][time]), group, Math.min(...rows.map(row=>row[time])), Math.max(...rows.map(row=>row[time])) + 1,
      rows.length, chunk.raw_bytes, chunk.sha256, chunk.payload, rows.reduce((sum,row)=>sum+row[up],0), rows.reduce((sum,row)=>sum+row[down],0));
  return chunk;
}

// One bounded batch per scheduler turn. The caller yields between batches so
// capture imports, lock messages and other operations continue to be serviced.
export function archiveBatch(store, cutoff, { limit = 512, beforeCommit } = {}) {
  const db = store.db;
  let kind = 'samples', rows = db.prepare('SELECT * FROM samples WHERE at<? ORDER BY at LIMIT ?').all(cutoff,limit);
  let group = '';
  if (!rows.length) {
    // Handle many short-lived connections in one bounded transaction instead
    // of spending one scheduler delay per one-row connection.
    const candidates=db.prepare('SELECT DISTINCT connection_id FROM buckets WHERE minute<? LIMIT 64').all(cutoff);
    if(!candidates.length)return {moved:0};
    const read=db.prepare('SELECT * FROM buckets WHERE connection_id=? AND minute<? ORDER BY minute,scope LIMIT ?');
    const groups=[];let count=0;
    for(const candidate of candidates){
      if(count>=limit)break;
      const selected=read.all(candidate.connection_id,cutoff,limit-count);let segment=[],bytes=2,month;
      for(const row of selected){
        const value=bucketColumns.map(column=>row[column]),size=Buffer.byteLength(JSON.stringify(value))+1,nextMonth=monthAt(row.minute);
        if(segment.length&&(bytes+size>MAX_RAW||nextMonth!==month)){groups.push({id:candidate.connection_id,month,rows:segment});segment=[];bytes=2;}
        segment.push(row);bytes+=size;month=nextMonth;count++;
      }
      if(segment.length)groups.push({id:candidate.connection_id,month,rows:segment});
    }
    db.exec('BEGIN IMMEDIATE');
    try{
      let rawBytes=0,compressedBytes=0;
      const remove=db.prepare('DELETE FROM buckets WHERE minute=? AND connection_id=? AND scope=?');
      for(const segment of groups){
        const chunk=insertChunk(db,'buckets',segment.id,segment.rows);rawBytes+=chunk.raw_bytes;compressedBytes+=chunk.payload.length;
        for(const row of segment.rows)remove.run(row.minute,segment.id,row.scope);
      }
      beforeCommit?.();db.exec('COMMIT');
      return {moved:count,kind:'buckets',month:groups[0].month,rawBytes,compressedBytes};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  const time = kind === 'samples' ? 'at' : 'minute', month = monthAt(rows[0][time]);
  const bounded = []; let bytes = 2;
  for (const row of rows) {
    if (monthAt(row[time]) !== month) break;
    const size = Buffer.byteLength(JSON.stringify((kind==='samples'?sampleColumns:bucketColumns).map(column=>row[column]))) + 1;
    if (bytes + size > MAX_RAW && bounded.length) break;
    bytes += size; bounded.push(row);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const chunk = insertChunk(db,kind,group,bounded);
    const remove = db.prepare(kind==='samples'?'DELETE FROM samples WHERE at=?':'DELETE FROM buckets WHERE minute=? AND connection_id=? AND scope=?');
    for (const row of bounded) remove.run(...(kind==='samples'?[row.at]:[row.minute,row.connection_id,row.scope]));
    beforeCommit?.();
    db.exec('COMMIT');
    invalidateReplaySampleCache(db);
    return { moved: bounded.length, kind, month, rawBytes: chunk.raw_bytes, compressedBytes: chunk.payload.length };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function archivedSampleExists(db, at) {
  let cache = replaySampleCaches.get(db);
  if (!cache) {
    const upper = db.prepare("SELECT end_at FROM vault_archive_chunks WHERE kind='samples' ORDER BY end_at DESC LIMIT 1").get();
    cache = { end: upper?.end_at ?? -Infinity, blocks: new Map(), bytes: 0 };
    replaySampleCaches.set(db, cache);
  }
  if (at >= cache.end) return false;
  // Recent capture is usually newer than the archive. For older packets, use
  // the manifest to find overlapping compressed blocks before decoding them.
  let statements = replayStatements.get(db);
  if (!statements) {
    statements = {
      ids: db.prepare("SELECT id FROM vault_archive_chunks INDEXED BY archive_end WHERE kind='samples' AND start_at<=? AND end_at>?"),
      block: db.prepare('SELECT * FROM vault_archive_chunks WHERE id=?'),
    };
    replayStatements.set(db, statements);
  }
  for (const { id } of statements.ids.iterate(at, at)) {
    let block = cache.blocks.get(id);
    if (block) cache.blocks.delete(id);
    else {
      const times = new Set(unpack(statements.block.get(id)).rows.map(row => row[0]));
      block = { times, bytes: Math.max(64, times.size * 48) };
      if (block.bytes <= REPLAY_CACHE) cache.bytes += block.bytes;
    }
    if (block.bytes <= REPLAY_CACHE) cache.blocks.set(id, block);
    while (cache.bytes > REPLAY_CACHE) {
      const oldest = cache.blocks.keys().next().value;
      cache.bytes -= cache.blocks.get(oldest).bytes;
      cache.blocks.delete(oldest);
    }
    if (block.times.has(at)) return true;
  }
  return false;
}
function invalidateReplaySampleCache(db){replaySampleCaches.delete(db);}

// A time predicate on the manifest prunes compressed blocks before decoding.
// group_key stays a real indexed SQL column, so detail joins by connection id
// never rescan/decompress the entire archive for each selected connection.
export function attachArchiveViews(db, { windows } = {}) {
  if (!hasArchives(db)) return false;
  const state = { windows: windows || [{ from: 0, to: Number.MAX_SAFE_INTEGER }], authorized: windows, cache: new Map(), cacheBytes: 0 };
  states.set(db,state);
  db.function('tw_archive_json',{deterministic:true},(payload,hash,rawBytes,count)=>{
    let value = state.cache.get(hash);
    if (value) { state.cache.delete(hash); state.cache.set(hash,value); return value; }
    value = unpack({payload,sha256:hash,raw_bytes:rawBytes,row_count:count}).json;
    const bytes = Buffer.byteLength(value) * 2;
    if (bytes <= READ_CACHE) {
      state.cache.set(hash,value);state.cacheBytes+=bytes;
      while (state.cacheBytes>READ_CACHE) { const first=state.cache.keys().next().value;state.cacheBytes-=Buffer.byteLength(state.cache.get(first))*2;state.cache.delete(first); }
    }
    return value;
  });
  rebuildViews(db,state);
  return true;
}
function rebuildViews(db,state) {
  const overlap = state.windows.length ? state.windows.map(w=>`(a.start_at<${w.to} AND a.end_at>${w.from})`).join(' OR ') : '0';
  const json = 'json_each(tw_archive_json(a.payload,a.sha256,a.raw_bytes,a.row_count)) j';
  const projection = columns => columns.map((column,index)=>`json_extract(j.value,'$[${index}]') AS ${column}`).join(',');
  // A UNION view can force materialization before metadata joins even when
  // its archive branch is empty. Keep recent/no-archive reads on real indexes.
  const kinds=new Set(db.prepare(`SELECT DISTINCT kind FROM main.vault_archive_chunks a WHERE ${overlap}`).all().map(row=>row.kind));
  db.exec(`DROP VIEW IF EXISTS temp.tw_all_samples; DROP VIEW IF EXISTS temp.tw_all_buckets;
    CREATE TEMP VIEW tw_all_samples AS SELECT * FROM main.samples ${kinds.has('samples')?`UNION ALL
      SELECT ${projection(sampleColumns)} FROM main.vault_archive_chunks a,${json} WHERE a.kind='samples' AND (${overlap})`:''};
    CREATE TEMP VIEW tw_all_buckets AS SELECT minute,connection_id,scope,up,down,last_at FROM main.buckets ${kinds.has('buckets')?`UNION ALL
      SELECT json_extract(j.value,'$[0]') minute,a.group_key connection_id,json_extract(j.value,'$[1]') scope,
        json_extract(j.value,'$[2]') up,json_extract(j.value,'$[3]') down,json_extract(j.value,'$[4]') last_at
      FROM main.vault_archive_chunks a,${json} WHERE a.kind='buckets' AND (${overlap})`:''};`);
  if (!state.authorized) db.exec(`DROP VIEW IF EXISTS temp.samples;DROP VIEW IF EXISTS temp.buckets;
    CREATE TEMP VIEW samples AS SELECT * FROM temp.tw_all_samples;CREATE TEMP VIEW buckets AS SELECT * FROM temp.tw_all_buckets;`);
}
export function setArchiveWindows(db, windows) {
  const state=states.get(db);if(!state)return;
  state.windows=state.authorized ? windows.flatMap(w=>state.authorized.map(a=>({from:Math.max(a.from,w.from),to:Math.min(a.to,w.to)}))).filter(w=>w.to>w.from) : windows;
  // Call before query_only=ON, or temporarily disable it for TEMP schema only.
  db.exec('PRAGMA query_only=OFF');
  try { rebuildViews(db,state); } finally { db.exec('PRAGMA query_only=ON'); }
}
export function archiveSource(db,table) { return states.has(db) ? `temp.tw_all_${table}` : `main.${table}`; }
export function archiveIntersects(db,range,kind='buckets') {
  return hasArchives(db)&&Boolean(db.prepare('SELECT 1 FROM main.vault_archive_chunks WHERE kind=? AND start_at<? AND end_at>? LIMIT 1').get(kind,range.to,range.from));
}
export function detachArchiveViews(db) {
  const state=states.get(db);if(!state)return;
  if(!state.authorized)db.exec('DROP VIEW IF EXISTS temp.samples;DROP VIEW IF EXISTS temp.buckets');
  db.exec('DROP VIEW IF EXISTS temp.tw_all_samples;DROP VIEW IF EXISTS temp.tw_all_buckets');states.delete(db);
}
export function historyBounds(db, windows) {
  const state=states.get(db);windows??=state?.authorized;
  const condition = column => windows?.length ? ' WHERE '+windows.map(w=>`(${column}>=${w.from} AND ${column}<${w.to})`).join(' OR ') : '';
  // Unscoped bounds use block extrema without decoding old data. Scoped bounds
  // must inspect only intersecting blocks; using month extrema would leak dates.
  // SQLite walks the entire table to answer a combined MIN/MAX query. An
  // unscoped lookup can read each end of the primary key independently.
  const live = windows?.length
    ? db.prepare(`SELECT MIN(at) firstAt,MAX(at) lastAt FROM main.samples${condition('at')}`).get()
    : db.prepare(`SELECT
      (SELECT at FROM main.samples ORDER BY at LIMIT 1) firstAt,
      (SELECT at FROM main.samples ORDER BY at DESC LIMIT 1) lastAt`).get();
  if (!hasArchives(db)) return live;
  if (windows) {
    let firstAt=live.firstAt??Infinity,lastAt=live.lastAt??-Infinity;
    const include=value=>{firstAt=Math.min(firstAt,value);lastAt=Math.max(lastAt,value);};
    const overlap=windows.map(w=>`(start_at<${w.to} AND end_at>${w.from})`).join(' OR ');
    for(const chunk of db.prepare(`SELECT * FROM main.vault_archive_chunks WHERE kind='samples' AND (${overlap||'0'})`).iterate()){
      if(windows.some(w=>chunk.start_at>=w.from&&chunk.end_at<=w.to)){include(chunk.start_at);include(chunk.end_at-1);}
      else for(const row of unpack(chunk).rows)if(windows.some(w=>row[0]>=w.from&&row[0]<w.to))include(row[0]);
    }
    return {firstAt:Number.isFinite(firstAt)?firstAt:null,lastAt:Number.isFinite(lastAt)?lastAt:null};
  }
  const old = db.prepare(`SELECT
    (SELECT MIN(start_at) FROM main.vault_archive_chunks WHERE kind='samples') firstAt,
    (SELECT MAX(end_at)-1 FROM main.vault_archive_chunks WHERE kind='samples') lastAt`).get();
  return {firstAt:Math.min(...[live.firstAt,old.firstAt].filter(x=>x!==null))===Infinity?null:Math.min(...[live.firstAt,old.firstAt].filter(x=>x!==null)),
    lastAt:Math.max(...[live.lastAt,old.lastAt].filter(x=>x!==null))===-Infinity?null:Math.max(...[live.lastAt,old.lastAt].filter(x=>x!==null))};
}

// Caller owns the transaction. Partial blocks are recompressed and verified;
// deletion dates remain exact and intentionally deleted packets cannot replay.
export function deleteArchivedWindows(db, windows) {
  if (!hasArchives(db)) return;
  const max=db.prepare('SELECT COALESCE(MAX(id),0) id FROM vault_archive_chunks').get().id;
  const read=db.prepare('SELECT * FROM vault_archive_chunks WHERE id>? AND id<=? AND ('+windows.map(()=>'(start_at<? AND end_at>?)').join(' OR ')+') ORDER BY id LIMIT 8');
  let cursor=0;
  while(true){
    const affected=read.all(cursor,max,...windows.flatMap(w=>[w.to,w.from]));if(!affected.length)break;
    for (const chunk of affected) {
    const remaining=unpack(chunk).rows.filter(row=>!windows.some(w=>row[0]>=w.from&&row[0]<w.to));
    db.prepare('DELETE FROM vault_archive_chunks WHERE id=?').run(chunk.id);
    if(remaining.length) {
      const columns=chunk.kind==='samples'?sampleColumns:bucketColumns;
      insertChunk(db,chunk.kind,chunk.group_key,remaining.map(row=>Object.fromEntries(columns.map((column,index)=>[column,row[index]]))));
    }
    }
    cursor=affected.at(-1).id;
  }
  invalidateReplaySampleCache(db);
}
export function archiveSummary(db) {
  if (!hasArchives(db)) return { months:[],rows:0,rawBytes:0,compressedBytes:0,firstAt:null,lastAt:null };
  const months=db.prepare(`SELECT month,SUM(row_count) rows,SUM(raw_bytes) rawBytes,SUM(length(payload)) compressedBytes,
    MIN(start_at) firstAt,MAX(end_at)-1 lastAt,SUM(kind='samples') sampleBlocks,SUM(kind='buckets') connectionBlocks
    FROM vault_archive_chunks GROUP BY month ORDER BY month DESC`).all();
  return { months,rows:months.reduce((n,m)=>n+m.rows,0),rawBytes:months.reduce((n,m)=>n+m.rawBytes,0),compressedBytes:months.reduce((n,m)=>n+m.compressedBytes,0),
    firstAt:months.length?Math.min(...months.map(m=>m.firstAt)):null,lastAt:months.length?Math.max(...months.map(m=>m.lastAt)):null };
}
export const archiveCutoff = (now,days=90) => Math.floor((now-days*DAY)/60000)*60000;

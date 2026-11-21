import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from './database.mjs';
import { createHash } from 'node:crypto';
import { historyBounds,archiveIntersects } from './history-archive.mjs';
import { prepareCacheFile, limitCacheConnection, cacheFailed } from './storage-files.mjs';

const HOUR = 3600000;
const CACHE_FORMAT=3;
// Disposable read-side summaries. The collector database is always read-only;
// exact connection/scope identities are retained, including historical unknowns.
export function programRollup(source, cacheRoot, range, firstAt, now, defs, aggregate) {
  // An hourly builder would repeatedly scan compressed rows. Old ranges use one
  // exact streaming aggregation; only the ordinary online range builds a cache.
  if(archiveIntersects(source,range))return null;
  const from = Math.ceil(Math.max(range.from, firstAt ?? range.to) / HOUR) * HOUR;
  const to = Math.floor(Math.min(range.to, now - 120000) / HOUR) * HOUR;
  if (!cacheRoot || to <= from) return null;
  // Cold caches must never duplicate an unbounded connection dictionary before
  // returning the first result. Above these conservative budgets an exact
  // source aggregation costs less than building/overflowing the bounded cache.
  if(source.prepare('SELECT 1 FROM connections LIMIT 1 OFFSET 64000').get()||
    source.prepare('SELECT 1 FROM buckets WHERE minute>=? AND minute<? LIMIT 1 OFFSET 200000').get(range.from,range.to))return null;
  fs.mkdirSync(cacheRoot, { recursive: true });
  const file=path.join(cacheRoot, 'windows-programs-v2.sqlite');
  if(!prepareCacheFile(file))return null;
  const db = new DatabaseSync(file);
  try {
    limitCacheConnection(db);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=800;
      PRAGMA cache_size=-16384; PRAGMA temp_store=MEMORY;
      CREATE TABLE IF NOT EXISTS hours (hour INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS usage_hourly (
        hour INTEGER,connection_id TEXT,scope TEXT,up INTEGER,down INTEGER,minute INTEGER,last_at INTEGER,
        PRIMARY KEY(hour,connection_id,scope)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS usage_codex ON usage_hourly(connection_id,hour) WHERE scope='codex';
      CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY,host TEXT,network TEXT,process TEXT,pid INTEGER,
        scope TEXT,evidence TEXT,first_seen INTEGER,last_seen INTEGER,rule TEXT) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS connection_families (connection_id TEXT PRIMARY KEY,family TEXT,root_process TEXT,updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS program_bases (key TEXT PRIMARY KEY,value TEXT,at INTEGER);
      CREATE TABLE IF NOT EXISTS base_members (key TEXT,connection_id TEXT,scope TEXT,process TEXT,family TEXT,
        PRIMARY KEY(key,connection_id,scope)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS base_members_identity ON base_members(connection_id) WHERE scope<>'unknown';
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value INTEGER);
      CREATE TEMP TABLE edge_usage (connection_id TEXT,scope TEXT,up INTEGER,down INTEGER,minute INTEGER,last_at INTEGER);`);
    const bounds=historyBounds(source),latest=bounds.lastAt||0,earliest=bounds.firstAt||0;
    const previous = db.prepare("SELECT value FROM state WHERE key='metadataAt'").get()?.value || 0;
    const previousFirst = db.prepare("SELECT value FROM state WHERE key='firstAt'").get()?.value;
    const revision=source.prepare("SELECT value FROM settings WHERE key='historyDataRevision'").get()?.value||'0';
    const oldRevision=db.prepare("SELECT value FROM state WHERE key='revision'").get()?.value;
    const oldFormat=db.prepare("SELECT value FROM state WHERE key='format'").get()?.value;
    if (oldFormat!==CACHE_FORMAT||latest < previous || (previousFirst !== undefined && previousFirst !== earliest)||oldRevision!==undefined&&String(oldRevision)!==String(revision)) {
      db.exec('DELETE FROM hours; DELETE FROM usage_hourly; DELETE FROM connections; DELETE FROM connection_families; DELETE FROM state; DELETE FROM program_bases; DELETE FROM base_members;');
    }
    const metadataAt = db.prepare("SELECT value FROM state WHERE key='metadataAt'").get()?.value || 0;
    const hasFamilies = source.prepare("SELECT 1 FROM sqlite_master WHERE name='connection_families'").get();
    const updateConnection = db.prepare(`INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      host=excluded.host,network=excluded.network,process=excluded.process,pid=excluded.pid,scope=excluded.scope,
      evidence=excluded.evidence,last_seen=excluded.last_seen,rule=excluded.rule`);
    const updateFamily = db.prepare(`INSERT INTO connection_families VALUES(?,?,?,?) ON CONFLICT(connection_id)
      DO UPDATE SET family=excluded.family,root_process=excluded.root_process,updated_at=excluded.updated_at`);
    const oldIdentity = db.prepare('SELECT c.process,c.evidence,f.family,f.root_process FROM connections c LEFT JOIN connection_families f ON f.connection_id=c.id WHERE c.id=?');
    const inBase = db.prepare("SELECT 1 FROM base_members WHERE connection_id=? AND scope<>'unknown' LIMIT 1");
    let identityChanged = false;
    db.exec('BEGIN');
    for (const c of source.prepare(`SELECT c.id,c.process,c.evidence,c.last_seen${hasFamilies ? ',f.family,f.root_process,f.updated_at' : ''} FROM connections c
      ${hasFamilies ? 'LEFT JOIN connection_families f ON f.connection_id=c.id' : ''} WHERE c.last_seen>=?`).iterate(Math.max(0, metadataAt - 120000))) {
      if (metadataAt) {
        const old = oldIdentity.get(c.id);
        if (!identityChanged && old && ['process','evidence','family','root_process'].some(key=>(old[key] || '') !== (c[key] || '')) && inBase.get(c.id)) identityChanged = true;
      }
      // Program summaries do not need duplicated domains, endpoints or raw rule JSON.
      updateConnection.run(c.id,'','',c.process,null,'',c.evidence,0,c.last_seen,'{}');
      if (c.family) updateFamily.run(c.id,c.family,c.root_process,c.updated_at);
    }
    const saveState = db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    saveState.run('metadataAt', latest); saveState.run('firstAt', earliest);saveState.run('revision',Number(revision));saveState.run('format',CACHE_FORMAT);
    if(identityChanged) db.exec('DELETE FROM program_bases; DELETE FROM base_members;');
    db.exec('COMMIT');
    const ready = new Set(db.prepare('SELECT hour FROM hours WHERE hour>=? AND hour<?').all(from,to).map(x=>x.hour));
    const readHour = source.prepare(`SELECT connection_id,scope,SUM(up) up,SUM(down) down,MIN(minute) minute,MAX(last_at) last_at
      FROM buckets WHERE minute>=? AND minute<? GROUP BY connection_id,scope`);
    const insert = db.prepare('INSERT INTO usage_hourly VALUES(?,?,?,?,?,?,?)');
    for (let hour = from; hour < to; hour += HOUR) {
      if (ready.has(hour)) continue;
      db.exec('BEGIN');
      for (const row of readHour.iterate(hour,hour+HOUR)) insert.run(hour,row.connection_id,row.scope,row.up,row.down,row.minute,row.last_at);
      db.prepare('INSERT INTO hours VALUES(?)').run(hour);
      db.exec('COMMIT');
    }
    const edge = db.prepare('INSERT INTO edge_usage VALUES(?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (const [begin,end] of [[range.from,from],[to,range.to]]) {
      if (end <= begin) continue;
      for (const row of readHour.iterate(begin,end)) edge.run(row.connection_id,row.scope,row.up,row.down,row.minute,row.last_at);
    }
    db.exec('COMMIT');
    if (defs && aggregate) {
      const key = createHash('sha256').update(JSON.stringify([from,to,defs.apps])).digest('hex');
      let base = db.prepare('SELECT value FROM program_bases WHERE key=?').get(key);
      if (!base) {
        db.exec('BEGIN');
        db.prepare(`CREATE TEMP TABLE base_usage AS SELECT connection_id,scope,SUM(up) up,SUM(down) down,MIN(minute) minute,MAX(last_at) last_at
          FROM usage_hourly WHERE hour>=? AND hour<? GROUP BY connection_id,scope`).run(from,to);
        const rows = aggregate(db,{sql:`FROM base_usage b ${defs.metadataJoin}`,params:[]});
        db.prepare(`INSERT INTO base_members SELECT ?,c.id,b.scope,${defs.name},${defs.family} FROM base_usage b ${defs.metadataJoin}`).run(key);
        const content = JSON.stringify(rows);
        db.prepare('INSERT INTO program_bases VALUES(?,?,?)').run(key,content,now);
        base = { value:content };
        for (const expired of db.prepare('SELECT key FROM program_bases ORDER BY at DESC LIMIT -1 OFFSET 3').all()) {
          db.prepare('DELETE FROM base_members WHERE key=?').run(expired.key); db.prepare('DELETE FROM program_bases WHERE key=?').run(expired.key);
        }
        db.exec('COMMIT');
      }
      const edgeRows = aggregate(db,{sql:`FROM edge_usage b ${defs.metadataJoin}`,params:[]});
      const additional = db.prepare(`SELECT process,scope,family,COUNT(DISTINCT id) count FROM (
        SELECT c.id,b.scope,${defs.name} process,${defs.family} family FROM edge_usage b ${defs.metadataJoin}
        WHERE NOT EXISTS(SELECT 1 FROM base_members m WHERE m.key=? AND m.connection_id=c.id AND m.scope=b.scope AND m.process=${defs.name} AND m.family=${defs.family})
        ) GROUP BY process,scope,family`).all(key);
      const identity = row=>JSON.stringify([row.process,row.scope,row.family]);
      const additions = new Map(additional.map(row=>[identity(row),row.count]));
      const merged = new Map(JSON.parse(base.value).map(row=>[identity(row),row]));
      for (const row of edgeRows) {
        const previous = merged.get(identity(row));
        if (!previous) merged.set(identity(row),row);
        else { previous.up+=row.up;previous.down+=row.down;previous.firstAt=Math.min(previous.firstAt,row.firstAt);previous.lastAt=Math.max(previous.lastAt,row.lastAt);previous.connections+=additions.get(identity(row)) || 0; }
      }
      return {db,rows:[...merged.values()].sort((a,b)=>(b.up+b.down)-(a.up+a.down))};
    }
    return { db, filter: {
      prefix: `WITH usage AS MATERIALIZED (SELECT connection_id,scope,SUM(up) up,SUM(down) down,MIN(minute) minute,MAX(last_at) last_at
        FROM (SELECT connection_id,scope,up,down,minute,last_at FROM usage_hourly WHERE hour>=? AND hour<?
          UNION ALL SELECT * FROM edge_usage) GROUP BY connection_id,scope)`,
      params: [from,to],
    } };
  } catch (error) { db.close(); cacheFailed(file,error);throw error; }
}

export function codexScopeCandidates(source, cacheRoot, range) {
  const ids = new Set(), first = historyBounds(source).firstAt;
  const from = Math.max(range.from, Math.floor((first ?? range.to)/60000)*60000), to = range.to;
  const intervals = [];
  let db;
  try {
    const file = cacheRoot && path.join(cacheRoot,'windows-programs-v2.sqlite');
    if(file && fs.existsSync(file)&&!archiveIntersects(source,range)) {
      db=new DatabaseSync(file,{readOnly:true});
      if(db.prepare("SELECT value FROM state WHERE key='firstAt'").get()?.value !== first) {db.close();db=null;}
    }
    if(db) {
      for(const row of db.prepare("SELECT DISTINCT connection_id FROM usage_hourly WHERE scope='codex' AND hour>=? AND hour<?").iterate(Math.floor(from/HOUR)*HOUR,to)) ids.add(row.connection_id);
      let cursor=from;
      for(const {hour} of db.prepare('SELECT hour FROM hours WHERE hour>=? AND hour<? ORDER BY hour').all(Math.floor(from/HOUR)*HOUR,to)) {
        if(hour>cursor)intervals.push([cursor,Math.min(hour,to)]);cursor=Math.max(cursor,hour+HOUR);
      }
      if(cursor<to)intervals.push([cursor,to]);
    }else intervals.push([from,to]);
  }catch{intervals.length=0;intervals.push([from,to]);ids.clear();}
  finally{db?.close();}
  const raw=source.prepare("SELECT DISTINCT connection_id FROM buckets WHERE scope='codex' AND minute>=? AND minute<?");
  for(const [begin,end]of intervals)if(end>begin)for(const row of raw.iterate(begin,end))ids.add(row.connection_id);
  return JSON.stringify([...ids]);
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync as PlainDatabase } from 'node:sqlite';
import { Store } from './store.mjs';
import { purposeKey } from './vault-crypto.mjs';
import { recoverCompaction,finishRecoveredCompaction } from './storage-compaction.mjs';

const TABLES = ['settings','samples','connections','connection_families','buckets','sessions','alerts','collection_gaps','anomalies','daily_usage','budget_notifications'];
export const historyFile = (dataRoot, lane) => path.join(dataRoot, lane, 'history.vault.sqlite');
export function vaultKeyEntries(dataRoot, secrets, cacheRoot) {
  const master = Buffer.from(secrets.master, 'base64');
  try {
    const entries = ['windows','clash'].map(lane => [historyFile(dataRoot,lane), purposeKey(master, `database/${lane}`)]);
    if (cacheRoot) entries.push([path.join(cacheRoot,'windows-programs-v2.sqlite'), purposeKey(master,'database/summary-cache')]);
    return entries;
  } finally { master.fill(0); }
}

// Streaming copies never create a plaintext intermediate. Each chunk is
// committed with its cursor; interruption resumes without skipping a row.
export async function migrateLane(dataRoot, lane, key, { signal, progress = () => {} } = {}) {
  const dir = path.join(dataRoot,lane), sourceFile = path.join(dir,'monitor.sqlite');
  recoverCompaction(path.join(dir,'history.vault.sqlite'));
  const target = new Store(dir, { filename: 'history.vault.sqlite', encryptionKey: key });
  finishRecoveredCompaction(path.join(dir,'history.vault.sqlite'),target.db);
  target.db.exec('CREATE TABLE IF NOT EXISTS vault_migration(name TEXT PRIMARY KEY,cursor INTEGER NOT NULL,done INTEGER NOT NULL DEFAULT 0)');
  if(target.db.prepare("SELECT done FROM vault_migration WHERE name='complete'").get()?.done) return target;
  if (!fs.existsSync(sourceFile)) { target.db.prepare("INSERT OR REPLACE INTO vault_migration VALUES ('complete',0,1)").run(); return target; }
  progress({lane,table:'校验原有历史'});
  const source = new PlainDatabase(sourceFile, { readOnly: true });
  try {
    source.exec('PRAGMA query_only=ON;PRAGMA busy_timeout=3000;BEGIN');
    if (source.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('legacy_integrity_failed');
    const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    for (const table of TABLES.filter(table=>tables.has(table))) {
      if (signal?.aborted) throw new Error('migration_cancelled');
      let state = target.db.prepare('SELECT * FROM vault_migration WHERE name=?').get(table);
      if (state?.done) continue;
      if (!state) {
        target.db.exec('PRAGMA foreign_keys=OFF');
        target.db.exec(`BEGIN;DELETE FROM "${table}";INSERT INTO vault_migration VALUES ('${table}',-1,0);COMMIT`);
        state = { cursor: -1 };
      }
      target.db.exec('PRAGMA foreign_keys=OFF');
      const columns = source.prepare(`PRAGMA table_info("${table}")`).all().map(row=>row.name);
      const insert = target.db.prepare(`INSERT INTO "${table}" (${columns.map(column=>`"${column}"`).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
      while (true) {
        if (signal?.aborted) throw new Error('migration_cancelled');
        const rows = source.prepare(`SELECT rowid AS migration_rowid,* FROM "${table}" WHERE rowid>? ORDER BY rowid LIMIT 2000`).all(state.cursor);
        if (!rows.length) break;
        target.db.exec('BEGIN');
        try {
          for (const row of rows) insert.run(...columns.map(column=>row[column]));
          state.cursor = rows.at(-1).migration_rowid;
          target.db.prepare('UPDATE vault_migration SET cursor=? WHERE name=?').run(state.cursor,table);
          target.db.exec('COMMIT');
        } catch (error) { target.db.exec('ROLLBACK'); throw error; }
        progress({ lane,table,cursor:state.cursor }); await new Promise(resolve=>setImmediate(resolve));
      }
      const oldCount = source.prepare(`SELECT COUNT(*) count FROM "${table}"`).get().count;
      const newCount = target.db.prepare(`SELECT COUNT(*) count FROM "${table}"`).get().count;
      if (oldCount !== newCount) throw new Error('migration_count_mismatch');
      target.db.prepare('UPDATE vault_migration SET done=1 WHERE name=?').run(table);
    }
    const totals = db => db.prepare('SELECT SUM(all_up) up,SUM(all_down) down,SUM(codex_up) harnessUp,SUM(codex_down) harnessDown FROM samples').get();
    if (JSON.stringify(totals(source)) !== JSON.stringify(totals(target.db))) throw new Error('migration_totals_mismatch');
    if (target.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || target.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('migration_integrity_failed');
    target.db.prepare("INSERT OR REPLACE INTO vault_migration VALUES ('complete',0,1)").run();
    target.db.exec('PRAGMA foreign_keys=ON;PRAGMA wal_checkpoint(TRUNCATE)');
    return target;
  } catch (error) { target.close(); throw error; }
  finally { source.close(); }
}

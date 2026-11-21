import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { DiagnosticHistory } from '../src/ai-diagnostic-store.mjs';
import { HISTORY_LANES, HISTORY_MANIFEST, MIGRATED_HISTORY, historyFilename } from '../src/history-paths.mjs';
import { purposeKey, openPacket, unlockVaultKeys } from './legacy-keys.mjs';
import { initializeImport, importEnvelope } from './legacy-traffic.mjs';

const legacyRequire = createRequire(import.meta.url);
const legacyDatabase = 'history.vault.sqlite';
const signatures = ['','-wal'];
const ident = name => '"' + name.replaceAll('"', '""') + '"';
const sha = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', value => hash.update(value)).on('end', () => resolve(hash.digest('hex')));
});
async function copyVerified(source, target, label) {
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const digest = await sha(source);
  if (await sha(target) !== digest) throw new Error(`migration_copy_mismatch:${label}`);
  return digest;
}
async function matchesVerifiedOutput(filename, digest) {
  if (!digest || !fs.existsSync(filename)) return false;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || fs.realpathSync(filename).toLowerCase() !== filename.toLowerCase()) return false;
  if (['-wal', '-journal'].some(suffix => fs.statSync(filename + suffix, { throwIfNoEntry: false })?.size > 0)) return false;
  return await sha(filename) === digest;
}
function writeJson(file, value) {
  fs.writeFileSync(file + '.pending', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.pending', file);
}
function legacyInputs(root) {
  const files = ['vault/vault.json'];
  for (const lane of HISTORY_LANES) {
    for (const name of [legacyDatabase, 'ingest.sqlite']) {
      for (const suffix of signatures) {
        const relative = `${lane}/${name}${suffix}`;
        if (fs.existsSync(path.join(root, relative))) files.push(relative);
      }
    }
    for (const name of ['capture-preferences.json', 'monitor.sqlite', 'monitor.sqlite-wal']) {
      const relative = `${lane}/${name}`;
      if (fs.existsSync(path.join(root, relative))) files.push(relative);
    }
    if (!files.includes(`${lane}/${legacyDatabase}`)) throw new Error(`missing_legacy_database:${lane}`);
  }
  const folder = path.join(root, 'diagnostics', 'attachments');
  if (fs.existsSync(folder)) for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.sealed$/.test(entry.name)) throw new Error('unexpected_legacy_attachment');
    files.push(`diagnostics/attachments/${entry.name}`);
  }
  return Object.fromEntries(files.sort().map(relative => {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('unsafe_migration_source');
    return [relative, { size: stat.size, mtimeMs: stat.mtimeMs }];
  }));
}
function integrity(db, label, foreignKeys = true) {
  const results = db.prepare('PRAGMA integrity_check').all();
  if (results.some(row => Object.values(row)[0] !== 'ok')) throw new Error(`migration_integrity_failed:${label}:${Object.values(results[0])[0]}`);
  if (foreignKeys && db.prepare('PRAGMA foreign_key_check').get()) throw new Error(`migration_foreign_key_failed:${label}`);
}
function metrics(db, lane) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const counts = Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT COUNT(*) n FROM ${ident(name)}`).get().n]));
  const sums = table => db.prepare(`SELECT COALESCE(SUM(all_up),0) up,COALESCE(SUM(all_down),0) down FROM ${table}`).get();
  const buckets = counts.buckets !== undefined ? db.prepare('SELECT COALESCE(SUM(up),0) up,COALESCE(SUM(down),0) down FROM buckets').get() : null;
  const archive = counts.vault_archive_chunks !== undefined ? db.prepare('SELECT kind, SUM(row_count) rows, SUM(up) up, SUM(down) down, COUNT(*) chunks FROM vault_archive_chunks GROUP BY kind ORDER BY kind').all() : [];
  return { counts, ...(lane === 'diagnostics' ? {} : { samples: sums('samples'), daily: sums('daily_usage'), buckets, archive }) };
}
async function convertDatabase(root, lane, dir, master, inputs, notify) {
  const source = path.join(root, lane, legacyDatabase), target = path.join(dir, historyFilename(lane));
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(target + suffix, { force: true });
  notify({ lane, phase: 'copy' });
  const originals = {};
  for (const suffix of signatures) {
    if (!inputs[`${lane}/${legacyDatabase}${suffix}`]) continue;
    originals[suffix || 'main'] = await copyVerified(source + suffix, target + suffix, lane + '/' + legacyDatabase + suffix);
  }
  const Cipher = legacyRequire('better-sqlite3-multiple-ciphers');
  const key = purposeKey(master, `database/${lane}`);
  const db = new Cipher(target, { fileMustExist: true, timeout: 5000 });
  let before;
  try {
    db.key(key);
    if (db.pragma('wal_checkpoint(TRUNCATE)')[0].busy) throw new Error(`migration_snapshot_busy:${lane}`);
    db.pragma('journal_mode=DELETE');
    notify({ lane, phase: 'inspect' });
    integrity(db, lane);
    before = metrics(db, lane);
    if (lane !== 'diagnostics' && inputs[`${lane}/monitor.sqlite`]) {
      const completed = before.counts.vault_migration && db.prepare("SELECT done FROM vault_migration WHERE name='complete'").get()?.done;
      if (!completed) throw new Error(`legacy_plain_history_not_imported:${lane}`);
    }
    notify({ lane, phase: 'convert', before });
    db.rekey(Buffer.alloc(0));
  } finally { key.fill(0); db.close(); }
  const plain = new DatabaseSync(target, { readOnly: true });
  try {
    integrity(plain, lane);
    if (JSON.stringify(metrics(plain, lane)) !== JSON.stringify(before)) throw new Error(`migration_totals_mismatch:${lane}`);
  } finally { plain.close(); }
  return { before, originals };
}

function decodeDiagnostic(row, metadata, key) {
  const packet = JSON.parse(Buffer.from(row.payload).toString('utf8'));
  if (packet.header?.id !== row.id || packet.header?.vault !== metadata.id || packet.header?.lane !== 'diagnostics') throw new Error('ingest_header_mismatch');
  return openPacket(packet, key, metadata.capturePublicKey);
}

function importDiagnostic(history, row, metadata, key) {
  const db = history.db, digest = crypto.createHash('sha256').update(row.payload).digest('hex');
  const previous = db.prepare('SELECT digest FROM imports WHERE id=?').get(row.id);
  if (previous) {
    if (previous.digest !== digest) throw new Error('ingest_id_conflict');
    return false;
  }
  const events = decodeDiagnostic(row, metadata, key);
  if (!Array.isArray(events) || events.length > 1024) throw new Error('invalid_diagnostic_batch');
  for (const event of events) history.put(event);
  db.prepare('INSERT INTO imports VALUES (?,?)').run(row.id, digest);
  return true;
}

async function replayLane(root, lane, dir, metadata, secrets, inputs, notify) {
  const diag = lane === 'diagnostics';
  const store = diag ? new DiagnosticHistory(root, { directory: dir }) : new Store(dir);
  const db = store.db;
  const key = diag ? crypto.createPrivateKey(secrets.privateKey) : null;
  const receipts = diag ? 'imports' : 'vault_imports';
  const queueSHA256 = {};
  let total = 0, scanned = 0, added = 0;
  try {
    if (diag) db.exec('CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, digest TEXT NOT NULL)');
    else { store.vaultLane = lane; initializeImport(store); }
    const queueFile = path.join(root, lane, 'ingest.sqlite');
    if (inputs[`${lane}/ingest.sqlite`]) {
      // Use a private snapshot so even journal recovery cannot modify a legacy file.
      const localQueue = path.join(dir, 'migration-input.sqlite');
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(localQueue + suffix, { force: true });
      for (const suffix of signatures) {
        if (!inputs[`${lane}/ingest.sqlite${suffix}`]) continue;
        queueSHA256[suffix || 'main'] = await copyVerified(queueFile + suffix, localQueue + suffix, lane + '/ingest.sqlite' + suffix);
      }
      const queue = new DatabaseSync(localQueue);
      try {
        integrity(queue, lane + '/queue');
        total = queue.prepare('SELECT COUNT(*) n FROM envelopes').get().n;
        let batch = 0;
        db.exec('BEGIN IMMEDIATE');
        for (const row of queue.prepare('SELECT sequence,id,payload FROM envelopes ORDER BY sequence').iterate()) {
          try { added += Number(diag ? importDiagnostic(store, row, metadata, key) : importEnvelope(store, row, metadata, secrets)); }
          catch (error) { throw new Error(`migration_packet_failed:${lane}:${row.sequence}:${error.message}`, { cause: error }); }
          scanned++;
          if (++batch === 128) {
            db.exec('COMMIT'); batch = 0;
            notify({ lane, phase: 'queue', scanned, total, added });
            db.exec('BEGIN IMMEDIATE');
          }
        }
        db.exec('COMMIT');
        const read = db.prepare(`SELECT digest FROM ${receipts} WHERE id=?`);
        for (const row of queue.prepare('SELECT sequence,id,payload FROM envelopes').iterate()) {
          if (read.get(row.id)?.digest !== crypto.createHash('sha256').update(row.payload).digest('hex')) throw new Error(`migration_receipt_missing:${lane}:${row.sequence}`);
        }
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
      finally { queue.close(); }
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(localQueue + suffix, { force: true });
    }
    let attachments = 0;
    if (diag) {
      for (const relative of Object.keys(inputs).filter(relative => relative.startsWith('diagnostics/attachments/'))) {
        const id = path.basename(relative, '.sealed');
        const value = decodeDiagnostic({ id, payload: fs.readFileSync(path.join(root, relative)) }, metadata, key);
        const bytes = Buffer.from(value.bytes, 'base64');
        if (bytes.toString('base64') !== value.bytes) throw new Error('migration_attachment_encoding_failed');
        store.putAttachment(id, value.from, value.to, bytes);
        const check = store.attachment(id);
        if (check.bytes !== value.bytes || check.from !== value.from || check.to !== value.to) throw new Error('migration_attachment_verification_failed');
        attachments++;
      }
    } else {
      const preferencesPath = `${lane}/capture-preferences.json`;
      if (inputs[preferencesPath]) {
        const current = JSON.parse(fs.readFileSync(path.join(root, preferencesPath), 'utf8'));
        for (const pref of ['harnessApps', 'captureMode', 'retentionDays', 'alertMBPerMinute', 'budget']) {
          if (Object.hasOwn(current, pref)) store.set(pref, current[pref]);
        }
      }
    }
    if (scanned !== total) throw new Error(`migration_queue_count_mismatch:${lane}`);
    // Receipts, workflow cursors, and deleted date ranges only serve the old importer.
    // The unchanged original files still contain them for audit and rollback.
    for (const name of [receipts, 'vault_gap_ids', 'vault_deletions', 'vault_migration']) db.exec(`DROP TABLE IF EXISTS ${ident(name)}`);
    if (db.prepare('PRAGMA auto_vacuum').get().auto_vacuum === 0 && !diag) {
      notify({ lane, phase: 'rebuild_for_incremental_vacuum' });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA journal_mode=WAL');
    }
    integrity(db, lane);
    const after = metrics(db, lane);
    const check = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (check.busy || db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw new Error(`migration_wal_verification_failed:${lane}`);
    return { queue: { total, scanned, added, alreadyImported: total - added }, queueSHA256, attachments, after };
  } finally { store.close(); }
}

export async function migrateHistory(root, credential, { notify = () => {} } = {}) {
  root = path.resolve(root);
  const inputs = legacyInputs(root);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'vault', 'vault.json'), 'utf8'));
  const secrets = await unlockVaultKeys(metadata, credential, /^TW-(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/i.test(credential));
  const master = Buffer.from(secrets.master, 'base64');
  const output = path.join(root, MIGRATED_HISTORY), outputManifest = path.join(output, HISTORY_MANIFEST);
  try {
    if (fs.existsSync(output)) {
      const prior = JSON.parse(fs.readFileSync(outputManifest, 'utf8'));
      if (prior.version !== 1 || prior.vaultId !== metadata.id || !prior.verified || JSON.stringify(prior.inputs) !== JSON.stringify(inputs)) {
        throw new Error('migration_output_already_exists_or_source_changed');
      }
      for (const lane of HISTORY_LANES) {
        const target = path.join(output, lane, historyFilename(lane));
        if (!await matchesVerifiedOutput(target, prior.lanes?.[lane]?.outputSHA256)) throw new Error(`migration_output_changed:${lane}`);
      }
      return prior;
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 16);
    const stage = path.join(root, '.migration-' + fingerprint);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(stage).toLowerCase() !== stage.toLowerCase()) throw new Error('unsafe_migration_stage');
    const stateFile = path.join(stage, HISTORY_MANIFEST);
    const manifest = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { version: 1, vaultId: metadata.id, verified: false, inputs, lanes: {} };
    if (manifest.vaultId !== metadata.id || JSON.stringify(manifest.inputs) !== JSON.stringify(inputs)) throw new Error('migration_input_changed');
    for (const lane of HISTORY_LANES) {
      const dir = path.join(stage, lane);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.realpathSync(dir).toLowerCase() !== dir.toLowerCase()) throw new Error('unsafe_migration_lane');
      const target = path.join(dir, historyFilename(lane));
      if (await matchesVerifiedOutput(target, manifest.lanes[lane]?.outputSHA256)) {
        notify({ lane, phase: 'resume_verified_lane' }); continue;
      }
      const original = await convertDatabase(root, lane, dir, master, inputs, notify);
      const result = await replayLane(root, lane, dir, metadata, secrets, inputs, notify);
      manifest.lanes[lane] = { ...original, ...result, outputSHA256: await sha(target) };
      writeJson(stateFile, manifest);
      notify({ lane, phase: 'verified', ...result });
    }
    if (JSON.stringify(legacyInputs(root)) !== JSON.stringify(inputs)) throw new Error('migration_input_changed_during_run');
    manifest.verified = true;
    manifest.completedAt = Date.now();
    writeJson(stateFile, manifest);
    // Single rename publishes all three lanes. Until then, the old installation remains usable.
    fs.renameSync(stage, output);
    return manifest;
  } finally { master.fill(0); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , flag, dataRoot] = process.argv;
    if (flag !== '--data-root' || !dataRoot) throw new Error('usage: migrate-history.mjs --data-root <path> (credential on stdin)');
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 4096) throw new Error('invalid_migration_credential');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks), password = bytes.toString('utf8').replace(/\r?\n$/, '');
    bytes.fill(0); for (const chunk of chunks) chunk.fill(0);
    if (!password) throw new Error('missing_migration_credential');
    const result = await migrateHistory(dataRoot, password, { notify: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ migrated: result.verified, lanes: Object.keys(result.lanes), completedAt: result.completedAt }));
  } catch (error) { console.error('TrafficWatch history migration:', error.message); process.exitCode = 1; }
}

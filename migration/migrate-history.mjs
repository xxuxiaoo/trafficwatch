import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { DiagnosticHistory } from '../src/ai-diagnostic-store.mjs';
import { HISTORY_LANES, HISTORY_MANIFEST, MIGRATED_HISTORY, historyFilename } from '../src/history-paths.mjs';
import { purposeKey, unlockVaultKeys } from './legacy-keys.mjs';
import { decodeEnvelope, InvalidLegacyPacket, packetDigest, initializeImport, importEnvelope } from './legacy-traffic.mjs';

const legacyRequire = createRequire(import.meta.url);
const legacyDatabase = 'history.vault.sqlite';
const signatures = ['', '-wal'];
const sidecars = ['', '-wal', '-shm', '-journal'];
const capturePreferences = ['harnessApps', 'captureMode', 'retentionDays', 'alertMBPerMinute', 'budget'];
const REPLAY_STATE = 'migration-replay.sqlite';
const replayTables = {
  imports: 'id,digest', vault_imports: 'id,digest',
  vault_gap_ids: 'id,gap_id', vault_deletions: 'start_at,end_at',
};
const ident = name => '"' + name.replaceAll('"', '""') + '"';
const sha = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', value => hash.update(value)).on('end', () => resolve(hash.digest('hex')));
});
async function copyVerified(source, target, label, expected) {
  await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  const digest = expected ?? await sha(source);
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
function isLocalPath(filename, kind) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  return Boolean(stat?.[kind]() && fs.realpathSync(filename).toLowerCase() === filename.toLowerCase());
}
function laneInputs(inputs, lane, filter = () => true) {
  const prefix = `${lane}/`;
  return JSON.stringify(Object.entries(inputs).filter(([name]) => name.startsWith(prefix) && filter(name.slice(prefix.length))));
}

function earlierStages(root, stage, vaultId, notify) {
  const candidates = [];
  for (const name of fs.readdirSync(root)) {
    const rollback = /^history-v2-rollback-[a-f0-9]{32}$/.test(name);
    if (!rollback && !/^\.migration-[a-f0-9]{16}$/.test(name)) continue;
    const directory = path.join(root, name), filename = path.join(directory, HISTORY_MANIFEST);
    if (directory === stage || !isLocalPath(directory, 'isDirectory') || !isLocalPath(filename, 'isFile')) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      notify({ phase: 'checkpoint_ignored', checkpoint: name, reason: 'invalid_manifest_json' });
      continue;
    }
    if (manifest?.version === 1 && manifest.vaultId === vaultId && manifest.inputs && manifest.lanes && (!rollback || manifest.verified === true)) {
      candidates.push({ directory, manifest });
    }
  }
  return candidates;
}

async function matchesOriginals(root, lane, name, currentInputs, recordedInputs, digests, { allowEmptyWal = false } = {}) {
  const required = [];
  for (const suffix of signatures) {
    const relative = `${lane}/${name}${suffix}`;
    const current = currentInputs[relative], prior = recordedInputs[relative];
    const recorded = digests?.[suffix || 'main'];
    if (allowEmptyWal && suffix && !current?.size && !prior?.size) continue;
    if (!current && !prior && !recorded) continue;
    if (!current || !prior || current.size !== prior.size || !recorded) return false;
    required.push([relative, recorded]);
  }
  for (const [relative, recorded] of required) {
    if (await sha(path.join(root, relative)) !== recorded) return false;
  }
  return true;
}

async function reusableLane(root, lane, inputs, candidates, notify, { stage, getQueue } = {}) {
  const plainInputs = name => name === 'monitor.sqlite' || name === 'monitor.sqlite-wal';
  const options = candidates.flatMap(({ directory, manifest }) => {
    const previous = manifest.lanes[lane];
    if (!previous?.outputSHA256) return [];
    const exact = laneInputs(inputs, lane) === laneInputs(manifest.inputs, lane);
    const base = directory !== stage && lane !== 'diagnostics' && previous.queue?.total === 0 &&
      laneInputs(inputs, lane, plainInputs) === laneInputs(manifest.inputs, lane, plainInputs);
    const stableInputs = name => !['ingest.sqlite', 'ingest.sqlite-wal', 'capture-preferences.json'].includes(name);
    const append = directory !== stage && Boolean(previous.replayStateSHA256 && previous.queuePrefixSHA256) &&
      laneInputs(inputs, lane, stableInputs) === laneInputs(manifest.inputs, lane, stableInputs);
    return [{ directory, manifest, previous, exact, base, append }];
  }).sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.append) - Number(a.append) ||
    Number(b.manifest.verified === true) - Number(a.manifest.verified === true));
  for (const { directory, manifest, previous, exact, base, append } of options) {
    const checkpoint = path.basename(directory);
    const target = path.join(directory, lane, historyFilename(lane));
    const replayFile = path.join(directory, lane, REPLAY_STATE);
    let reason;
    if (['-wal', '-journal'].some(suffix => fs.statSync(target + suffix, { throwIfNoEntry: false })?.size > 0)) reason = 'output_has_unverified_journal';
    else if (!await matchesVerifiedOutput(target, previous.outputSHA256)) reason = 'output_checksum_changed';
    else if (!exact && !base && !append) reason = 'inputs_changed_without_replay_state';
    else if (!await matchesOriginals(root, lane, legacyDatabase, inputs, manifest.inputs, previous.originals, { allowEmptyWal: true })) reason = 'encrypted_history_changed';
    else if (previous.replayStateSHA256 && !await matchesVerifiedOutput(replayFile, previous.replayStateSHA256)) reason = 'replay_state_checksum_changed';
    else if (exact && await matchesOriginals(root, lane, 'ingest.sqlite', inputs, manifest.inputs, previous.queueSHA256)) {
      return { ...previous, target, replayFile, checkpoint, replay: false };
    } else if (append && getQueue) {
      const queue = await getQueue();
      if (queue && queuePrefixMatches(queue.db, previous.queue.total, previous.queuePrefixSHA256)) {
        return { ...previous, target, replayFile, checkpoint, replay: 'append' };
      }
      reason = 'queue_prefix_changed';
    } else if (base) return { ...previous, target, replayFile, checkpoint, replay: 'base' };
    else reason = append ? 'queue_needs_offline_verification' : 'queue_checksum_changed';
    notify({ lane, phase: 'checkpoint_ignored', checkpoint, reason });
  }
  return null;
}

export async function inspectCheckpoints(root, notify) {
  root = path.resolve(root);
  const inputs = legacyInputs(root);
  const { id } = JSON.parse(fs.readFileSync(path.join(root, 'vault', 'vault.json'), 'utf8'));
  const candidates = earlierStages(root, null, id, notify);
  for (const lane of HISTORY_LANES) {
    const previous = await reusableLane(root, lane, inputs, candidates, notify);
    notify({ lane, phase: 'preflight_checkpoint', plan: previous?.replay || (previous ? 'verified_lane' : 'rebuild'),
      checkpoint: previous?.checkpoint, previousQueue: previous?.queue.total });
  }
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
function integrity(db, label, { quick = false } = {}) {
  const failed = db.prepare(quick ? 'PRAGMA quick_check' : 'PRAGMA integrity_check').all().find(row => Object.values(row)[0] !== 'ok');
  if (failed) throw new Error(`migration_integrity_failed:${label}:${Object.values(failed)[0]}`);
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error(`migration_foreign_key_failed:${label}`);
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
  for (const suffix of sidecars) fs.rmSync(target + suffix, { force: true });
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

function importDiagnostic(history, row, digest, decode) {
  const db = history.db;
  const previous = db.prepare('SELECT digest FROM imports WHERE id=?').get(row.id);
  if (previous) {
    if (previous.digest !== digest) throw new InvalidLegacyPacket('ingest_id_conflict');
    return { status: 'alreadyImported', issues: [] };
  }
  const events = decode(row);
  if (!Array.isArray(events) || events.length > 1024) throw new InvalidLegacyPacket('invalid_diagnostic_batch');
  const issues = [];
  for (const [index, event] of events.entries()) {
    if (!event || (event.kind === 'incident' && !Array.isArray(event.evidence))) {
      issues.push({ operation: index + 1, reason: 'invalid_diagnostic_event' });
      continue;
    }
    try { history.put(event); }
    catch (error) {
      if (!['invalid_diagnostic_event', 'diagnostic_event_too_large', 'invalid_diagnostic_replacement'].includes(error.message)) throw error;
      issues.push({ operation: index + 1, reason: error.message });
    }
  }
  const applied = !issues.length || issues.length < events.length;
  if (applied) db.prepare('INSERT INTO imports VALUES (?,?)').run(row.id, digest);
  return { status: applied ? 'added' : 'quarantined', issues };
}

function copyReplayTables(source, target, tables) {
  const table = source.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
  target.exec('BEGIN IMMEDIATE');
  try {
    for (const name of tables) {
      if (!table.get(name)) continue;
      const columns = replayTables[name];
      const values = columns.split(',');
      const insert = target.prepare(`INSERT INTO ${name} VALUES (${values.map(() => '?').join(',')})`);
      for (const row of source.prepare(`SELECT ${columns} FROM ${name}`).iterate()) insert.run(...values.map(key => row[key]));
    }
    target.exec('COMMIT');
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    throw error;
  }
}

async function saveReplayState(db, dir, tables) {
  const file = path.join(dir, REPLAY_STATE);
  for (const suffix of sidecars) fs.rmSync(file + suffix, { force: true });
  const state = new DatabaseSync(file);
  try {
    for (const name of tables) {
      state.exec(db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name).sql);
    }
    copyReplayTables(db, state, tables);
  } finally { state.close(); }
  return sha(file);
}

async function restoreReplayState(root, lane, dir, master, inputs, originals, db) {
  // The 0.10.16 checkpoint dropped its import receipts, deletion ranges and
  // gap IDs. Read these from a private copy: even a read-only SQLite handle
  // may create or write WAL sidecars beside the original encrypted database.
  const directory = fs.mkdtempSync(path.join(dir, '.legacy-replay-'));
  const source = path.join(root, lane, legacyDatabase), target = path.join(directory, legacyDatabase);
  let original;
  try {
    for (const suffix of signatures) {
      if (suffix && !inputs[`${lane}/${legacyDatabase}${suffix}`]?.size) continue;
      await copyVerified(source + suffix, target + suffix, `${lane}/replay_state${suffix}`, originals[suffix || 'main']);
    }
    const Cipher = legacyRequire('better-sqlite3-multiple-ciphers');
    const key = purposeKey(master, `database/${lane}`);
    try {
      original = new Cipher(target, { readonly: true, fileMustExist: true, timeout: 5000 });
      original.key(key);
    } finally { key.fill(0); }
    copyReplayTables(original, db, ['vault_gap_ids', 'vault_deletions', 'vault_imports']);
    db.exec('BEGIN IMMEDIATE');
    const pref = original.prepare('SELECT value FROM settings WHERE key=?');
    const set = db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)');
    const remove = db.prepare('DELETE FROM settings WHERE key=?');
    for (const name of capturePreferences) {
      const previous = pref.get(name);
      if (previous) set.run(name, previous.value);
      else remove.run(name);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    original?.close();
    for (const suffix of sidecars) fs.rmSync(target + suffix, { force: true });
    fs.rmdirSync(directory);
  }
}

const emptyPrefix = crypto.createHash('sha256').digest('hex');
const packetsByOrder = 'SELECT sequence,id,payload FROM envelopes ORDER BY sequence';
function addPacketToHash(hash, row, digest) {
  hash.update(JSON.stringify([row.sequence, row.id, digest]) + '\n');
}
function queuePrefixMatches(queue, total, expected) {
  if (!Number.isSafeInteger(total) || total < 0) return false;
  const prefix = crypto.createHash('sha256');
  let read = 0;
  for (const row of queue.prepare(packetsByOrder + ' LIMIT ?').iterate(total)) {
    addPacketToHash(prefix, row, packetDigest(row.payload));
    read++;
  }
  return read === total && prefix.digest('hex') === expected;
}

async function snapshotQueue(root, lane, dir, inputs) {
  if (!inputs[`${lane}/ingest.sqlite`]) return null;
  const file = path.join(dir, 'migration-input.sqlite');
  const removeSnapshot = () => { for (const suffix of sidecars) fs.rmSync(file + suffix, { force: true }); };
  removeSnapshot();
  const hashes = {};
  let db;
  try {
    for (const suffix of signatures) {
      const relative = `${lane}/ingest.sqlite${suffix}`;
      if (inputs[relative]) hashes[suffix || 'main'] = await copyVerified(path.join(root, relative), file + suffix, relative);
    }
    db = new DatabaseSync(file);
    integrity(db, lane + '/queue');
    return { db, hashes, close() { db.close(); removeSnapshot(); } };
  } catch (error) { db?.close(); removeSnapshot(); throw error; }
}

function replayQueue(queue, lane, db, receipts, apply, notify, previous) {
  const total = queue.prepare('SELECT COUNT(*) n FROM envelopes').get().n;
  const counts = { total, scanned: 0, added: 0, alreadyImported: 0, quarantined: 0, partial: 0 };
  const prefix = crypto.createHash('sha256');
  const quarantine = [...(previous?.quarantine || [])];
  const previouslyQuarantined = new Map(quarantine.map(row => [row.sequence, row]));
  let firstProxyControllerGapSequence = previous?.firstProxyControllerGapSequence ?? null;
  const packets = queue.prepare(packetsByOrder);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of packets.iterate()) {
      const digest = packetDigest(row.payload);
      addPacketToHash(prefix, row, digest);
      if (previous && counts.scanned < previous.queue.total) {
        const oldIssue = previouslyQuarantined.get(row.sequence);
        counts.scanned++;
        counts[oldIssue && !oldIssue.partial ? 'quarantined' : 'alreadyImported']++;
        if (oldIssue?.partial) counts.partial++;
        continue;
      }
      let result;
      try { result = apply(row, digest); }
      catch (error) {
        if (!(error instanceof InvalidLegacyPacket)) throw new Error(`migration_packet_failed:${lane}:${row.sequence}:${error.message}`, { cause: error });
        result = { status: 'quarantined', issues: [{ reason: error.message }] };
      }
      counts[result.status]++;
      counts.scanned++;
      if (result.proxyControllerGap && firstProxyControllerGapSequence === null) {
        firstProxyControllerGapSequence = row.sequence;
        notify({ lane, phase: 'legacy_gap_accepted', sequence: row.sequence, reason: 'proxy_controller_unavailable' });
      }
      if (result.issues.length) {
        const partial = result.status === 'added';
        if (partial) counts.partial++;
        const entry = { sequence: row.sequence, sha256: digest, partial, issues: result.issues };
        quarantine.push(entry);
        notify({ lane, phase: 'packet_quarantined', ...entry });
      }
      if (counts.scanned % 128 === 0) {
        db.exec('COMMIT');
        notify({ lane, phase: 'queue', ...counts });
        db.exec('BEGIN IMMEDIATE');
      }
    }
    db.exec('COMMIT');
    if (counts.scanned !== total || counts.added + counts.alreadyImported + counts.quarantined !== total) {
      throw new Error(`migration_queue_count_mismatch:${lane}`);
    }
    const read = db.prepare(`SELECT digest FROM ${receipts} WHERE id=?`);
    const unreadable = new Map(quarantine.filter(row => !row.partial).map(row => [row.sequence, row.sha256]));
    for (const row of packets.iterate()) {
      const digest = unreadable.get(row.sequence) ?? read.get(row.id)?.digest;
      if (digest !== packetDigest(row.payload)) throw new Error(`migration_receipt_missing:${lane}:${row.sequence}`);
    }
    return { counts, quarantine, firstProxyControllerGapSequence, queuePrefixSHA256: prefix.digest('hex') };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

async function replayLane(root, lane, dir, metadata, secrets, inputs, notify, resume, inputQueue) {
  const diag = lane === 'diagnostics';
  const store = diag ? new DiagnosticHistory(root, { directory: dir }) : new Store(dir);
  const db = store.db;
  const key = diag ? crypto.createPrivateKey(secrets.privateKey) : undefined;
  const signing = diag && metadata.capturePublicKey ? crypto.createPublicKey(metadata.capturePublicKey) : undefined;
  const decode = row => decodeEnvelope(row, metadata.id, lane, key, signing);
  const receipts = diag ? 'imports' : 'vault_imports';
  const tables = diag ? ['imports'] : ['vault_imports', 'vault_gap_ids', 'vault_deletions'];
  let counts = { total: 0, scanned: 0, added: 0, alreadyImported: 0, quarantined: 0, partial: 0 }, quarantine = [];
  let firstProxyControllerGapSequence = null, queuePrefixSHA256 = emptyPrefix;
  try {
    if (diag) db.exec('CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, digest TEXT NOT NULL)');
    else { store.vaultLane = lane; initializeImport(store); }
    if (resume?.previous) {
      const file = path.join(dir, REPLAY_STATE + '.input');
      fs.rmSync(file, { force: true });
      await copyVerified(resume.previous.replayFile, file, `${lane}/replay_state`, resume.previous.replayStateSHA256);
      const snapshot = new DatabaseSync(file, { readOnly: true });
      try { copyReplayTables(snapshot, db, tables); }
      finally { snapshot.close(); fs.rmSync(file, { force: true }); }
    } else if (resume) {
      await restoreReplayState(root, lane, dir, resume.master, inputs, resume.originals, db);
    }
    if (inputQueue) {
      const apply = diag ? (row, digest) => importDiagnostic(store, row, digest, decode) :
        (row, digest) => importEnvelope(store, row, digest, metadata, secrets);
      ({ counts, quarantine, firstProxyControllerGapSequence, queuePrefixSHA256 } =
        replayQueue(inputQueue.db, lane, db, receipts, apply, notify, resume?.previous));
    }
    let attachments = 0;
    if (diag) {
      for (const relative of Object.keys(inputs).filter(relative => relative.startsWith('diagnostics/attachments/'))) {
        const id = path.basename(relative, '.sealed');
        const value = decode({ id, payload: fs.readFileSync(path.join(root, relative)) });
        const bytes = Buffer.from(value.bytes, 'base64');
        if (bytes.toString('base64') !== value.bytes) throw new Error('migration_attachment_encoding_failed');
        if (!resume?.previous) store.putAttachment(id, value.from, value.to, bytes);
        const check = store.attachment(id);
        if (!check || check.bytes !== value.bytes || check.from !== value.from || check.to !== value.to) throw new Error('migration_attachment_verification_failed');
        attachments++;
      }
    } else {
      const preferencesPath = `${lane}/capture-preferences.json`;
      if (inputs[preferencesPath]) {
        const current = JSON.parse(fs.readFileSync(path.join(root, preferencesPath), 'utf8'));
        for (const pref of capturePreferences) {
          if (Object.hasOwn(current, pref)) store.set(pref, current[pref]);
        }
      }
    }
    // Receipts, workflow cursors, and deleted date ranges only serve the old importer.
    // The unchanged original files still contain them for audit and rollback.
    // Keep only migration receipts and mapping metadata in a separate checked
    // file. The live database never needs the old encryption or queue tables.
    const replayStateSHA256 = await saveReplayState(db, dir, tables);
    for (const name of [...tables, 'vault_migration']) db.exec(`DROP TABLE IF EXISTS ${ident(name)}`);
    if (db.prepare('PRAGMA auto_vacuum').get().auto_vacuum === 0 && !diag) {
      notify({ lane, phase: 'rebuild_for_incremental_vacuum' });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA journal_mode=WAL');
    }
    integrity(db, lane, { quick: Boolean(resume) });
    const after = metrics(db, lane);
    const check = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (check.busy || db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw new Error(`migration_wal_verification_failed:${lane}`);
    return { queue: counts, queueSHA256: inputQueue?.hashes || {}, queuePrefixSHA256, replayStateSHA256,
      quarantine, firstProxyControllerGapSequence, attachments, after };
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
    if (master.length !== 32 || !crypto.createPublicKey(crypto.createPrivateKey(secrets.privateKey)).equals(crypto.createPublicKey(metadata.publicKey))) {
      throw new Error('migration_vault_key_mismatch');
    }
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
    if (manifest.version !== 1 || manifest.vaultId !== metadata.id || JSON.stringify(manifest.inputs) !== JSON.stringify(inputs)) throw new Error('migration_input_changed');
    const candidates = [{ directory: stage, manifest }, ...earlierStages(root, stage, metadata.id, notify)];
    for (const lane of HISTORY_LANES) {
      const dir = path.join(stage, lane);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.realpathSync(dir).toLowerCase() !== dir.toLowerCase()) throw new Error('unsafe_migration_lane');
      const target = path.join(dir, historyFilename(lane));
      let inputQueue;
      const getQueue = async () => inputQueue ??= await snapshotQueue(root, lane, dir, inputs);
      try {
        const previous = await reusableLane(root, lane, inputs, candidates, notify, { stage, getQueue });
        if (previous && !previous.replay) {
          const { target: priorTarget, checkpoint, replay, replayFile, ...verified } = previous;
          if (priorTarget !== target) {
            for (const suffix of sidecars) fs.rmSync(target + suffix, { force: true });
            await copyVerified(priorTarget, target, `${lane}/verified_checkpoint`, verified.outputSHA256);
            if (verified.replayStateSHA256) {
              const state = path.join(dir, REPLAY_STATE);
              for (const suffix of sidecars) fs.rmSync(state + suffix, { force: true });
              await copyVerified(replayFile, state, `${lane}/replay_state`, verified.replayStateSHA256);
            }
            manifest.lanes[lane] = verified;
            writeJson(stateFile, manifest);
          }
          notify({ lane, phase: 'resume_verified_lane', checkpoint, queue: verified.queue });
          continue;
        }
        let original, resume;
        if (previous) {
          const append = previous.replay === 'append';
          notify({ lane, phase: append ? 'resume_verified_queue_prefix' : 'resume_verified_base',
            checkpoint: previous.checkpoint, previousQueue: previous.queue.total });
          for (const suffix of sidecars) fs.rmSync(target + suffix, { force: true });
          await copyVerified(previous.target, target, `${lane}/verified_checkpoint`, previous.outputSHA256);
          original = { before: previous.before, originals: previous.originals };
          resume = { master, originals: previous.originals, previous: append ? previous : undefined };
        } else {
          original = await convertDatabase(root, lane, dir, master, inputs, notify);
        }
        const result = await replayLane(root, lane, dir, metadata, secrets, inputs, notify, resume, await getQueue());
        manifest.lanes[lane] = { ...original, ...result, outputSHA256: await sha(target) };
        writeJson(stateFile, manifest);
        const { quarantine, ...verified } = result;
        notify({ lane, phase: 'verified', ...verified });
      } finally { inputQueue?.close(); }
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

async function cli(flag, dataRoot) {
  const notify = value => console.log(JSON.stringify(value));
  if (flag === '--inspect-checkpoints' && dataRoot) return inspectCheckpoints(dataRoot, notify);
  if (flag !== '--data-root' || !dataRoot) {
    throw new Error('usage: migrate-history.mjs (--data-root | --inspect-checkpoints) <path> (credential on stdin for migration)');
  }
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
  const result = await migrateHistory(dataRoot, password, { notify });
  notify({ migrated: result.verified, lanes: Object.keys(result.lanes), completedAt: result.completedAt });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await cli(...process.argv.slice(2));
  } catch (error) { console.error('TrafficWatch history migration:', error.message); process.exitCode = 1; }
}

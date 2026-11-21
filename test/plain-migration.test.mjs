import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { DiagnosticHistory } from '../src/ai-diagnostic-store.mjs';
import { archiveBatch } from '../src/history-archive.mjs';
import { historyDirectory, historyFilename, HISTORY_LANES } from '../src/history-paths.mjs';
import { readDetail } from '../src/overview-data.mjs';
import { purposeKey } from '../migration/legacy-keys.mjs';
import { initializeImport } from '../migration/legacy-traffic.mjs';
import { createVaultKeys, sealPacket, packetFormat } from './legacy-migration-fixture.mjs';
import { connection, BASE, MINUTE } from './history-synthetic-fixtures.mjs';

const Cipher = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers');
const migrationCLI = process.env.TRAFFICWATCH_MIGRATION_CLI || path.join(import.meta.dirname, '..', 'migration', 'migrate-history.mjs');
const { migrateHistory } = await import(pathToFileURL(path.resolve(migrationCLI)).href);
const password = 'synthetic-legacy-migration-password';
const at = BASE + MINUTE, next = at + 2 * MINUTE;
const uuid = '11111111-2222-3333-4444-555555555555';
const sample = (time, up, down) => ({
  at: time, duration: 1000, codexUp: 0, codexDown: 0, allUp: up, allDown: down, unknownUp: 0, unknownDown: 0,
  activeSessions: [], rows: [connection('test-program', up, down)],
});

async function legacy(t, { emptyWindowsQueue = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-migrate-'));
  const opened = [];
  const lanes = {};
  t.after(() => {
    for (const handle of opened) handle.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  });
  const { metadata, secrets, recoveryCode } = await createVaultKeys(password);
  const signing = crypto.generateKeyPairSync('ed25519');
  metadata.capturePublicKey = signing.publicKey.export({ format: 'pem', type: 'spki' });
  const master = Buffer.from(secrets.master, 'base64');
  const event = { at, id: 'recorded-request', kind: 'request', provider: 'fixture.test', category: 'success' };
  for (const lane of HISTORY_LANES) {
    const dir = path.join(root, lane), file = path.join(dir, 'history.vault.sqlite');
    const plain = path.join(dir, historyFilename(lane));
    if (lane === 'diagnostics') {
      const store = new DiagnosticHistory(root);
      store.append([event]); store.close();
    } else {
      const store = new Store(dir);
      initializeImport(store);
      store.record(sample(at, 33, 44));
      archiveBatch(store, at + MINUTE);
      store.db.prepare('INSERT INTO settings VALUES (?,?)').run('airportGroups', '[]');
      store.set('retentionDays', 0);
      if (lane === 'windows' && emptyWindowsQueue) {
        store.set('alertMBPerMinute', 12);
        const gap = store.openGap('source_unavailable', at);
        store.db.prepare('INSERT INTO vault_gap_ids VALUES (?,?)').run('previous-gap', gap);
        store.db.prepare('INSERT INTO vault_deletions VALUES (?,?)').run(next + MINUTE, next + 2 * MINUTE);
        fs.writeFileSync(path.join(dir, 'capture-preferences.json'), '{"alertMBPerMinute": 16}');
      }
      store.close();
    }
    fs.renameSync(plain, file);
    const d = new Cipher(file), key = purposeKey(master, `database/${lane}`);
    d.pragma('journal_mode=DELETE');
    d.rekey(key); d.pragma('journal_mode=WAL');
    // Keep a live WAL containing committed data. Migration opens only copies.
    d.exec('CREATE TABLE old_data(v INTEGER); INSERT INTO old_data VALUES(7)');
    opened.push(d); key.fill(0);
    const queue = new DatabaseSync(path.join(dir, 'ingest.sqlite'));
    queue.exec('PRAGMA journal_mode=WAL; CREATE TABLE envelopes(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE,payload BLOB)');
    const packet = (id, contents) => Buffer.from(JSON.stringify(sealPacket(contents, metadata.publicKey,
      { format: packetFormat, vault: metadata.id, lane, id }, signing.privateKey)));
    const append = (id, contents) => queue.prepare('INSERT INTO envelopes(id,payload) VALUES (?,?)').run(id, packet(id, contents));
    lanes[lane] = { queue, append, history: d };
    const payload = lane === 'diagnostics' ? [{ ...event, id: 'pending-request', at: next }]
      : [{ method: 'record', args: [sample(next, 5, 10)] }, { method: 'record', args: [sample(at, 33, 44)] }, { method: 'set', args: ['airportGroups', [1]] }];
    if (lane !== 'windows' || !emptyWindowsQueue) append('pending', payload);
    if (lane === 'windows') {
      const operations = [{ method: 'alert', args: [at, 'already applied'] }];
      const duplicate = packet('committed', operations);
      const alertPresent = d.prepare("SELECT 1 FROM alerts WHERE message='already applied'").get();
      assert.equal(alertPresent, undefined);
      d.prepare('INSERT INTO alerts(at,message) VALUES (?,?)').run(...operations[0].args);
      if (!emptyWindowsQueue) queue.prepare('INSERT INTO envelopes(id,payload) VALUES (?,?)').run('committed', duplicate);
      d.prepare('INSERT INTO vault_imports VALUES (?,?)').run('committed', crypto.createHash('sha256').update(duplicate).digest('hex'));
      lanes.windows.duplicate = duplicate;
    }
    if (lane === 'diagnostics') {
      fs.mkdirSync(path.join(dir, 'attachments'));
      fs.writeFileSync(path.join(dir, 'attachments', uuid + '.sealed'), packet(uuid,
        { from: at, to: next, bytes: Buffer.from('test-only trace').toString('base64') }));
    }
    opened.push(queue);
  }
  master.fill(0);
  fs.mkdirSync(path.join(root, 'vault'));
  fs.writeFileSync(path.join(root, 'vault', 'vault.json'), JSON.stringify(metadata));
  return { root, recoveryCode, lanes };
}

test('offline conversion preserves the source files, WAL rows, archives, attachments and exact traffic; restart resumes verified lanes', { timeout: 30000 }, async t => {
  const { root, recoveryCode } = await legacy(t);
  const notify = [];
  const file = path.join(root, 'windows', 'history.vault.sqlite');
  const original = fs.readFileSync(file), originalWal = fs.readFileSync(file + '-wal');
  assert.throws(() => historyDirectory(root, 'windows'), /history_migration_required/);
  await assert.rejects(migrateHistory(root, 'incorrect-password'), /wrong_password/);
  await assert.rejects(migrateHistory(root, password, { notify: value => {
    if (value.lane === 'windows' && value.phase === 'verified') throw new Error('test_interruption');
  } }), /test_interruption/);
  assert.equal(fs.existsSync(path.join(root, 'history-v2')), false);
  const manifest = await migrateHistory(root, recoveryCode, { notify: value => notify.push(value) });
  assert.equal(manifest.verified, true);
  assert.deepEqual(manifest.lanes.windows.queue, { total: 2, scanned: 2, added: 1, alreadyImported: 1, quarantined: 0, partial: 0 });
  assert.equal(manifest.lanes.diagnostics.attachments, 1);
  assert.ok(notify.some(value => value.lane === 'windows' && value.phase === 'resume_verified_lane'));
  for (const lane of HISTORY_LANES) {
    const db = new DatabaseSync(path.join(historyDirectory(root, lane), historyFilename(lane)));
    assert.equal(db.prepare('SELECT v FROM old_data').get().v, 7);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('envelopes','imports','vault_imports')").all().length, 0);
    if (lane !== 'diagnostics') assert.equal(db.prepare("SELECT 1 FROM settings WHERE key='airportGroups'").get(), undefined);
    db.close();
  }
  const detail = readDetail(root, 'windows', 'all', next + MINUTE);
  assert.deepEqual([detail.summary.up, detail.summary.down], [38, 54]);
  const diagnostics = new DiagnosticHistory(root);
  try {
    assert.equal(diagnostics.query({ windows: [{ from: 0, to: next + MINUTE }] }).rows.length, 2);
    assert.equal(Buffer.from(diagnostics.attachment(uuid).bytes, 'base64').toString(), 'test-only trace');
  } finally { diagnostics.close(); }
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readFileSync(file + '-wal'), originalWal);
});

test('legacy Clash gaps preserve their endpoints and only invalid operations or unreadable packets are quarantined', { timeout: 30000 }, async t => {
  const { root, lanes } = await legacy(t);
  const { queue, append } = lanes.clash;
  queue.exec('DELETE FROM envelopes');
  append('gap-and-traffic', [
    { method: 'openGap', args: ['controller', 'proxy_controller_unavailable', at] },
    { method: 'closeGap', args: ['controller', at - 1] },
    { method: 'openGap', args: ['still-open', 'collector_restart', String(at + 1)] },
    { method: 'closeGap', args: ['still-open', null] },
    { method: 'openGap', args: ['missing-start', 'proxy_controller_unavailable', null] },
    { method: 'anomaly', args: [{ kind: 'fixture', from: at }] },
    { method: 'record', args: [sample(next, 5, 10)] },
  ]);
  const damaged = Buffer.from('damaged');
  queue.prepare('INSERT INTO envelopes(id,payload) VALUES (?,?)').run('damaged', damaged);
  append('gap-only', [{ method: 'openGap', args: ['bad-reason', 'unexpected_reason', at] }]);
  append('later-traffic', [{ method: 'record', args: [sample(next + MINUTE, 9, 17)] }]);
  const notes = [];
  const migrated = await migrateHistory(root, password, { notify: row => notes.push(row) });
  assert.deepEqual(migrated.lanes.clash.queue, { total: 4, scanned: 4, added: 2, alreadyImported: 0, quarantined: 2, partial: 1 });
  assert.equal(migrated.lanes.clash.firstProxyControllerGapSequence, 1);
  const quarantine = migrated.lanes.clash.quarantine;
  assert.deepEqual(quarantine.map(({ sequence, partial, issues }) => ({ sequence, partial, issues })), [
    { sequence: 1, partial: true, issues: [{ operation: 5, reason: 'invalid_gap_start' }, { operation: 6, reason: 'invalid_legacy_anomaly' }] },
    { sequence: 2, partial: false, issues: [{ reason: 'invalid_ingest_json' }] },
    { sequence: 3, partial: false, issues: [{ operation: 1, reason: 'invalid_gap_reason' }] },
  ]);
  assert.equal(quarantine[1].sha256, crypto.createHash('sha256').update(damaged).digest('hex'));
  assert.equal(notes.filter(row => row.lane === 'clash' && row.phase === 'packet_quarantined').length, 3);
  const db = new DatabaseSync(path.join(historyDirectory(root, 'clash'), historyFilename('clash')), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT reason,started_at,ended_at FROM collection_gaps ORDER BY id').all().map(row => Object.values(row)), [
      ['proxy_controller_unavailable', at, at], ['collector_restart', at + 1, null],
    ]);
  } finally { db.close(); }
  const detail = readDetail(root, 'clash', 'all', next + 2 * MINUTE);
  assert.deepEqual([detail.summary.up, detail.summary.down], [47, 71]);
  assert.equal(queue.prepare('SELECT COUNT(*) n FROM envelopes').get().n, 4);
  assert.deepEqual(Buffer.from(queue.prepare('SELECT payload FROM envelopes WHERE sequence=2').get().payload), damaged);
});

test('after a Clash SQL failure, reuse the verified Windows base with a newer queue, receipts, gap IDs and deletion ranges', { timeout: 30000 }, async t => {
  const { root, lanes } = await legacy(t, { emptyWindowsQueue: true });
  const { clash, windows } = lanes;
  clash.append('failed-write', [{ method: 'saveSession', args: [{ id: 'invalid-session', title: null }] }]);
  await assert.rejects(migrateHistory(root, password), /migration_packet_failed:clash:2:NOT NULL constraint failed: sessions.title/);
  const checkpoint = path.join(root, fs.readdirSync(root).find(name => name.startsWith('.migration-')));
  const stateFile = path.join(checkpoint, 'migration.json');
  const prior = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(prior.verified, false);
  assert.equal(prior.lanes.windows.queue.total, 0);
  assert.equal(prior.lanes.clash, undefined);
  assert.equal(fs.existsSync(path.join(root, 'history-v2')), false);
  // 0.10.16 manifests had these earlier counters and no quarantine field.
  delete prior.lanes.windows.quarantine;
  delete prior.lanes.windows.queue.quarantined;
  delete prior.lanes.windows.queue.partial;
  fs.writeFileSync(stateFile, JSON.stringify(prior));

  clash.queue.prepare('DELETE FROM envelopes WHERE id=?').run('failed-write');
  clash.append('clash-gap', [{ method: 'openGap', args: ['controller', 'proxy_controller_unavailable', next] }]);
  windows.queue.prepare('INSERT INTO envelopes(id,payload) VALUES (?,?)').run('committed', windows.duplicate);
  windows.append('post-checkpoint', [
    { method: 'record', args: [sample(next, 13, 21)] },
    { method: 'record', args: [sample(next + MINUTE, 1000, 1000)] },
    { method: 'closeGap', args: ['previous-gap', next] },
  ]);
  const dir = path.join(root, 'windows');
  fs.writeFileSync(path.join(dir, 'capture-preferences.json'), '{"retentionDays": 3}');
  const originalFiles = ['history.vault.sqlite', 'history.vault.sqlite-wal', 'ingest.sqlite', 'ingest.sqlite-wal'];
  const originals = originalFiles.map(name => fs.readFileSync(path.join(dir, name)));
  const phases = [];
  const migrated = await migrateHistory(root, password, { notify: row => phases.push(row) });
  assert.equal(migrated.verified, true);
  assert.deepEqual(migrated.lanes.windows.queue, { total: 2, scanned: 2, added: 1, alreadyImported: 1, quarantined: 0, partial: 0 });
  const windowsPhases = phases.filter(row => row.lane === 'windows').map(row => row.phase);
  assert.deepEqual(windowsPhases, ['resume_verified_base', 'verified']);
  assert.ok(phases.some(row => row.lane === 'clash' && row.phase === 'convert'));
  assert.ok(phases.some(row => row.lane === 'diagnostics' && row.phase === 'verified'));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(checkpoint, 'windows', historyFilename('windows')))).digest('hex'), prior.lanes.windows.outputSHA256);
  originalFiles.forEach((name, index) => assert.deepEqual(fs.readFileSync(path.join(dir, name)), originals[index]));
  const db = new DatabaseSync(path.join(historyDirectory(root, 'windows'), historyFilename('windows')), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 1);
    assert.equal(db.prepare('SELECT ended_at FROM collection_gaps').get().ended_at, next);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='retentionDays'").get().value, '3');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='alertMBPerMinute'").get().value, '12');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
  const detail = readDetail(root, 'windows', 'all', next + 2 * MINUTE);
  assert.deepEqual([detail.summary.up, detail.summary.down], [46, 65]);
});

test('a verified Windows checkpoint is ignored when its source history WAL changes', { timeout: 30000 }, async t => {
  const { root, lanes } = await legacy(t, { emptyWindowsQueue: true });
  await assert.rejects(migrateHistory(root, password, { notify: row => {
    if (row.lane === 'windows' && row.phase === 'verified') throw new Error('test_interruption');
  } }), /test_interruption/);
  lanes.windows.history.exec('UPDATE old_data SET v=19');
  const phases = [];
  await migrateHistory(root, password, { notify: row => phases.push(row) });
  assert.ok(phases.some(row => row.lane === 'windows' && row.phase === 'checkpoint_ignored' && row.reason === 'encrypted_history_changed'));
  assert.ok(phases.some(row => row.lane === 'windows' && row.phase === 'convert'));
  const db = new DatabaseSync(path.join(historyDirectory(root, 'windows'), historyFilename('windows')), { readOnly: true });
  try { assert.equal(db.prepare('SELECT v FROM old_data').get().v, 19); }
  finally { db.close(); }
});

test('migration CLI reads the old password through stdin and writes a verified manifest', { timeout: 30000 }, async t => {
  const { root, recoveryCode } = await legacy(t);
  const runtime = process.env.TRAFFICWATCH_MIGRATION_RUNTIME || process.execPath;
  const converted = spawnSync(runtime, ['--disable-warning=ExperimentalWarning', migrationCLI, '--data-root', root], {
    input: recoveryCode + '\n', windowsHide: true, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(converted.status, 0, converted.stderr);
  assert(!converted.stdout.includes(recoveryCode));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'history-v2', 'migration.json'), 'utf8'));
  assert.equal(manifest.verified, true);
  assert.deepEqual(Object.keys(manifest.lanes), HISTORY_LANES);
  assert.match(manifest.lanes.clash.queueSHA256.main, /^[a-f0-9]{64}$/);
  assert.equal((await migrateHistory(root, recoveryCode)).completedAt, manifest.completedAt);
  const file = path.join(root, 'history-v2', 'clash', historyFilename('clash'));
  const altered = new DatabaseSync(file);
  try { altered.exec('UPDATE old_data SET v=8'); } finally { altered.close(); }
  await assert.rejects(migrateHistory(root, recoveryCode), /migration_output_changed:clash/);
  const retained = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(retained.prepare('SELECT v FROM old_data').get().v, 8); } finally { retained.close(); }
});

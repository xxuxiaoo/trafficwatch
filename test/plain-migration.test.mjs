import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { DiagnosticHistory } from '../src/ai-diagnostic-store.mjs';
import { archiveBatch } from '../src/history-archive.mjs';
import { historyDirectory, historyFilename, HISTORY_LANES } from '../src/history-paths.mjs';
import { readDetail } from '../src/overview-data.mjs';
import { migrateHistory } from '../migration/migrate-history.mjs';
import { purposeKey } from '../migration/legacy-keys.mjs';
import { initializeImport } from '../migration/legacy-traffic.mjs';
import { createVaultKeys, sealPacket, packetFormat } from './legacy-migration-fixture.mjs';
import { connection, BASE, MINUTE } from './history-synthetic-fixtures.mjs';

const Cipher = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers');
const password = 'synthetic-legacy-migration-password';
const at = BASE + MINUTE, next = at + 2 * MINUTE;
const uuid = '11111111-2222-3333-4444-555555555555';
const sample = (time, up, down) => ({
  at: time, duration: 1000, codexUp: 0, codexDown: 0, allUp: up, allDown: down, unknownUp: 0, unknownDown: 0,
  activeSessions: [], rows: [connection('test-program', up, down)],
});

async function legacy(t, { corrupt = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-migrate-'));
  const opened = [];
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
    const payload = lane === 'diagnostics' ? [{ ...event, id: 'pending-request', at: next }]
      : [{ method: 'record', args: [sample(next, 5, 10)] }, { method: 'record', args: [sample(at, 33, 44)] }, { method: 'set', args: ['airportGroups', [1]] }];
    const one = packet('pending', payload);
    queue.prepare('INSERT INTO envelopes(id,payload) VALUES (?,?)').run('pending', one);
    if (lane === 'windows') {
      const duplicate = packet('committed', [{ method: 'record', args: [sample(at, 33, 44)] }]);
      queue.prepare('INSERT INTO envelopes(id,payload) VALUES (?,?)').run('committed', duplicate);
      d.prepare('INSERT INTO vault_imports VALUES (?,?)').run('committed', crypto.createHash('sha256').update(duplicate).digest('hex'));
    }
    if (lane === 'clash' && corrupt) queue.prepare('UPDATE envelopes SET payload=?').run(Buffer.from('damaged'));
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
  return { root, recoveryCode };
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
  assert.deepEqual(manifest.lanes.windows.queue, { total: 2, scanned: 2, added: 1, alreadyImported: 1 });
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

test('a malformed legacy packet fails migration closed with lane and sequence and preserves the original three lanes', { timeout: 30000 }, async t => {
  const { root } = await legacy(t, { corrupt: true });
  await assert.rejects(migrateHistory(root, password), /migration_packet_failed:clash:1:/);
  assert.equal(fs.existsSync(path.join(root, 'history-v2')), false);
  for (const lane of HISTORY_LANES) {
    assert.ok(fs.existsSync(path.join(root, lane, 'history.vault.sqlite')));
    assert.ok(fs.existsSync(path.join(root, lane, 'ingest.sqlite')));
  }
});

test('migration CLI reads the old password through stdin and writes a verified manifest', { timeout: 30000 }, async t => {
  const { root, recoveryCode } = await legacy(t);
  const cli = process.env.TRAFFICWATCH_MIGRATION_CLI || path.join(import.meta.dirname, '..', 'migration', 'migrate-history.mjs');
  const runtime = process.env.TRAFFICWATCH_MIGRATION_RUNTIME || process.execPath;
  const converted = spawnSync(runtime, ['--disable-warning=ExperimentalWarning', cli, '--data-root', root], {
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

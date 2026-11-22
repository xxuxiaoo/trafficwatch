import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const helper = path.resolve(import.meta.dirname, '../scripts/upgrade-history.ps1');
const checksum = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const laneFiles = { windows: 'monitor.sqlite', clash: 'monitor.sqlite', diagnostics: 'history.sqlite' };

function plan(dir, version) {
  const command = "$ErrorActionPreference='Stop'; . $env:TW_TEST_HISTORY_HELPER; " +
    'try { Get-UpgradeHistoryPlan $env:TW_TEST_DATA_ROOT ([version]$env:TW_TEST_INSTALLED_VERSION) | ConvertTo-Json -Compress } ' +
    'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 8000,
    env: { ...process.env, TW_TEST_HISTORY_HELPER: helper, TW_TEST_DATA_ROOT: dir, TW_TEST_INSTALLED_VERSION: version },
  });
  if (result.error) throw result.error;
  return result;
}

test('Windows upgrade prioritizes the verified plaintext databases, even after live WAL writes', { skip: process.platform !== 'win32' }, t => {
  const location = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-verified-history-'));
  const root = fs.realpathSync(location), open = [];
  t.after(() => {
    for (const database of open) database.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const active = path.join(root, 'history-v2');
  fs.mkdirSync(path.join(root, 'vault'));
  fs.writeFileSync(path.join(root, 'vault', 'vault.json'), '{"retained":true}');
  const missing = plan(root, '0.10.18');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /active history-v2 is missing/);
  const legacy = plan(root, '0.10.14');
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).Mode, 'legacy-encrypted');

  const manifest = { version: 1, verified: true, lanes: {} };
  for (const [lane, name] of Object.entries(laneFiles)) {
    const file = path.join(active, lane, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    open.push(db);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (bytes INTEGER); INSERT INTO records VALUES(71); PRAGMA wal_checkpoint(TRUNCATE)');
    manifest.lanes[lane] = { outputSHA256: checksum(file) };
    db.exec('INSERT INTO records VALUES(89); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO records VALUES(97)');
    assert.notEqual(checksum(file), manifest.lanes[lane].outputSHA256);
    assert.ok(fs.statSync(file + '-wal').size > 0);
  }
  const manifestPath = path.join(active, 'migration.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const verified = plan(root, '0.10.18');
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), { Mode: 'verified-plain', Lanes: Object.keys(laneFiles) });
  for (const db of open) assert.equal(db.prepare('SELECT SUM(bytes) AS n FROM records').get().n, 257);

  manifest.verified = false;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const unverified = plan(root, '0.10.18');
  assert.notEqual(unverified.status, 0);
  assert.match(unverified.stderr, /active history-v2 migration has not been verified/);
  manifest.verified = true;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const diagnostics = open.pop();
  diagnostics.close();
  fs.writeFileSync(path.join(active, 'diagnostics', 'history.sqlite'), Buffer.alloc(128));
  const damaged = plan(root, '0.10.18');
  assert.notEqual(damaged.status, 0);
  assert.match(damaged.stderr, /diagnostics history does not have a plaintext SQLite header/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireInstance } from '../src/instance.mjs';

test('one data directory rejects a second collector and becomes available after release', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-lock-'));
  const first = acquireInstance(dir);
  t.after(() => {
    first.release();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.throws(() => acquireInstance(dir), /already has a collector/);
  first.release();
  const second = acquireInstance(dir);
  second.release();
  assert.equal(fs.existsSync(path.join(dir, 'collector.lock')), false);
});
test('only a verifiably dead owner is automatically reclaimed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'collector.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 12345, token: 'synthetic-stale' }));
  const lock = acquireInstance(dir, () => {
    const error = new Error('dead');
    error.code = 'ESRCH';
    throw error;
  });
  lock.release();
  fs.writeFileSync(file, 'incomplete');
  assert.throws(() => acquireInstance(dir), /unverifiable/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'incomplete');
});
test('permission errors cannot be mistaken for a dead process', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const content = JSON.stringify({ pid: 12345, token: 'synthetic-owner' }),
    file = path.join(dir, 'collector.lock');
  fs.writeFileSync(file, content);
  assert.throws(
    () =>
      acquireInstance(dir, () => {
        const e = new Error('denied');
        e.code = 'EPERM';
        throw e;
      }),
    /already has a collector/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('reused PID is reclaimed when process creation time or command line proves a different owner', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'collector.lock');
  const fakePid = process.pid + 100000;
  const oldTime = Date.now() - 3600_000;

  // 1. Legacy lock ({ pid, token } only) whose PID was later reused after a reboot.
  fs.writeFileSync(file, JSON.stringify({ pid: fakePid, token: 'legacy-stale' }));
  fs.utimesSync(file, new Date(oldTime), new Date(oldTime));
  const reclaimedLegacy = acquireInstance(
    dir,
    () => {},
    () => ({ alive: true, startedAt: Date.now(), commandLine: '"C:\\Program Files\\TrafficWatch\\runtime\\node.exe" "overview-server.mjs"' }),
  );
  reclaimedLegacy.release();

  // 2. New lock whose recorded pidStartedAt mismatches the currently running process.
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: fakePid, token: 'old-collector', startedAt: oldTime, pidStartedAt: oldTime - 1000, script: 'C:\\Program Files\\TrafficWatch\\src\\main.mjs' }),
  );
  const reclaimedNew = acquireInstance(
    dir,
    () => {},
    () => ({ alive: true, startedAt: Date.now(), commandLine: '"C:\\Program Files\\TrafficWatch\\runtime\\node.exe" "C:\\Program Files\\TrafficWatch\\src\\main.mjs"' }),
  );
  reclaimedNew.release();

  // 3. New lock whose PID was reused quickly by a different script (e.g. overview-server.mjs).
  const recent = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: fakePid, token: 'fast-reuse', startedAt: recent, pidStartedAt: recent, script: 'C:\\Program Files\\TrafficWatch\\src\\main.mjs' }),
  );
  const reclaimedDifferentCmd = acquireInstance(
    dir,
    () => {},
    () => ({ alive: true, startedAt: recent + 500, commandLine: '"node.exe" "overview-server.mjs"' }),
  );
  reclaimedDifferentCmd.release();

  // 4. Live collector with matching start time and script MUST NOT be reclaimed.
  const liveContent = JSON.stringify({
    pid: fakePid,
    token: 'real-collector',
    startedAt: recent,
    pidStartedAt: recent,
    script: 'C:\\Program Files\\TrafficWatch\\src\\main.mjs',
  });
  fs.writeFileSync(file, liveContent);
  assert.throws(
    () =>
      acquireInstance(
        dir,
        () => {},
        () => ({ alive: true, startedAt: recent + 1000, commandLine: '"C:\\Program Files\\TrafficWatch\\runtime\\node.exe" "C:\\Program Files\\TrafficWatch\\src\\main.mjs"' }),
      ),
    /already has a collector/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), liveContent);

  // 5. Unverifiable live process (inspect returns null or empty commandLine with matching time) fails closed.
  assert.throws(
    () => acquireInstance(dir, () => {}, () => null),
    /already has a collector/,
  );
  assert.throws(
    () => acquireInstance(dir, () => {}, () => ({ alive: true, startedAt: recent + 500, commandLine: null })),
    /already has a collector/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), liveContent);
});

test('real OS process identity inspection reclaims a stale lock pointing at an unrelated live process', async (t) => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-lock-os-'));
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  t.after(() => {
    try { decoy.kill(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(decoy.pid > 0);
  const file = path.join(dir, 'collector.lock');
  const staleAt = Date.now() - 180_000;
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid: decoy.pid,
      token: 'stale-reused-pid',
      startedAt: staleAt,
      pidStartedAt: staleAt,
      script: path.resolve(import.meta.dirname, '../src/main.mjs'),
    }),
  );
  fs.utimesSync(file, new Date(staleAt), new Date(staleAt));
  const acquired = acquireInstance(dir);
  try {
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.pid, process.pid);
  } finally {
    acquired.release();
  }
});

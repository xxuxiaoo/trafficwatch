import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { VERSION } from '../src/version.mjs';
const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function ready(port, child) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error('Monitor exited before readiness');
    try {
      const result = await fetch(`http://127.0.0.1:${port}/api/dashboard?range=all`, {
        headers: { 'X-Codex-Flow': '1' },
        signal: AbortSignal.timeout(1000),
      });
      if (result.ok) {
        const data = await result.json();
        if (data.totals.samples >= 2) return data;
      }
    } catch {
      /* Startup polling only, bounded above. */
    }
    await pause(100);
  }
  throw new Error('Monitor readiness timeout');
}
test(
  'real main process isolates demo data, rejects duplicate writers, and stops cleanly',
  { timeout: 35000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-main-'));
    const children = [];
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null) {
          const done = once(child, 'close');
          child.kill();
          await done;
        }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const port1 = await freePort(),
      port2 = await freePort();
    function launch(port) {
      const child = spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', main, '--demo'],
        {
          windowsHide: true,
          env: { ...process.env, CODEX_FLOW_PORT: String(port), CODEX_FLOW_DATA_DIR: dir },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      children.push(child);
      return child;
    }
    const first = launch(port1);
    const data = await ready(port1, first);
    assert.equal(data.status.demo, true);
    assert.ok(data.totals.codex_up > 0);
    assert.equal(fs.existsSync(path.join(dir, 'monitor.sqlite')), false);
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'monitor.sqlite')), true);
    const duplicate = launch(port2);
    let errors = '';
    duplicate.stderr.on('data', (chunk) => (errors += chunk.toString()));
    const [duplicateCode] = await once(duplicate, 'close');
    assert.equal(duplicateCode, 1);
    assert.match(errors, /already has a collector/);
    const firstExit = once(first, 'close');
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port1}/api/stop`, {
          method: 'POST',
          headers: { 'X-Codex-Flow': '1' },
          body: '{}',
        })
      ).status,
      200,
    );
    await firstExit;
    assert.equal(fs.existsSync(path.join(dir, 'demo', 'collector.lock')), false);
    const restarted = launch(port2);
    await ready(port2, restarted);
    const restartExit = once(restarted, 'close');
    await fetch(`http://127.0.0.1:${port2}/api/stop`, {
      method: 'POST',
      headers: { 'X-Codex-Flow': '1' },
      body: '{}',
    });
    await restartExit;
  },
);

test('real collector serves health during a SQLite schema write lock and only reports ready after opening history', { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-startup-'));
  const demo = path.join(dir, 'demo');
  const store = new Store(demo);
  store.db.exec('DROP INDEX connections_programs; BEGIN IMMEDIATE');
  let lockHeld = true;
  function release() {
    if (!lockHeld) return;
    lockHeld = false;
    store.db.exec('COMMIT');
    store.close();
  }
  const port = await freePort();
  const env = { ...process.env, CODEX_FLOW_PORT: String(port), CODEX_FLOW_DATA_DIR: dir, CODEX_NETWATCH_DESKTOP_TOKEN: '' };
  delete env.TRAFFICWATCH_SUITE_DATA_ROOT;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', main, '--demo'], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errorLog = '';
  child.stdout.resume();
  child.stderr.on('data', value => { errorLog += value; });
  const closed = once(child, 'close');
  t.after(async () => {
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^tw-startup-/);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const address = `http://127.0.0.1:${port}`;
  const health = () => fetch(address + '/api/health', { signal: AbortSignal.timeout(1200) });
  let first;
  const timeout = Date.now() + 8000;
  while (!first && Date.now() < timeout) {
    try { first = await health(); }
    catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
      if (child.exitCode !== null) throw new Error(errorLog);
      await pause(50);
    }
  }
  assert.equal(first?.status, 200, errorLog);
  assert.equal((await first.json()).startupStage, 'opening_history');
  const headers = { 'X-Codex-Flow': '1' };
  assert.equal((await fetch(address + '/api/overview-live', { headers, signal: AbortSignal.timeout(1200) })).status, 503);
  let probeResults;
  if (process.platform === 'win32') {
    const script = path.resolve(import.meta.dirname, '../scripts/upgrade-health.ps1');
    const command = `. '${script.replaceAll("'", "''")}'; $check=@{Port=${port};App='codex-flow';Collector=$true}; ` +
      `Wait-TrafficWatchHealth -Checks $check -Version '${VERSION}' -DeadlineMs 6000`;
    const probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    probe.stdout.on('data', value => { output += value; });
    probe.stderr.on('data', value => { output += value; });
    probeResults = once(probe, 'close').then(([code]) => ({ code, output }));
  }
  await pause(1350); // Longer than a pre-0.10.18 upgrade probe.
  const duringLock = await health();
  assert.equal(duringLock.status, 200);
  assert.equal((await duringLock.json()).startupStage, 'opening_history');
  release();
  const dashboard = await ready(port, child);
  assert.ok(dashboard.totals.samples >= 2);
  assert.equal((await (await health()).json()).startupStage, 'ready');
  const db = new DatabaseSync(path.join(demo, 'monitor.sqlite'), { readOnly: true });
  try {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='connections_programs'").get());
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  } finally { db.close(); }
  if (probeResults) {
    const { code, output } = await probeResults;
    assert.equal(code, 0, output);
    assert.match(output, /startup=opening_history[\s\S]*ready \(state=connected\)/);
  }
  assert.equal((await fetch(address + '/api/stop', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await closed)[0], 0, errorLog);
});

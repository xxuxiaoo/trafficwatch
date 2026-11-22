import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

const [candidate, output, previous, snapshot] = process.argv.slice(2);
assert(process.platform === 'win32' && candidate && output && previous && snapshot,
  'Usage: node test/installed-overview-smoke.mjs <package> <new-output-dir> <previous-package> <isolated-history-snapshot>');
const root = fs.realpathSync(candidate), prior = fs.realpathSync(previous), target = path.resolve(output);
const dataRoot = fs.realpathSync(snapshot);
const buildRoot = fs.realpathSync(path.resolve(import.meta.dirname, '../.build'));
assert.ok(dataRoot.startsWith(buildRoot + path.sep), 'Use a history snapshot inside this checkout’s .build directory');
assert.ok(path.join(fs.realpathSync(path.dirname(target)), path.basename(target)).startsWith(buildRoot + path.sep),
  'Keep smoke program files inside this checkout’s .build directory');
assert.ok(!fs.existsSync(target), 'Use a new smoke output directory');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const programFiles = path.join(target, 'Programs'), installed = path.join(programFiles, 'TrafficWatch');
const staged = path.join(programFiles, 'TrafficWatch.stage'), rollback = path.join(programFiles, 'TrafficWatch.rollback');
const log = path.join(target, 'overview-launch.log'), settingsFile = path.join(installed, 'suite-settings.json');
fs.mkdirSync(programFiles, { recursive: true });
fs.cpSync(prior, installed, { recursive: true, errorOnExist: true, force: false });
const settings = JSON.stringify({ DataRoot: dataRoot });
fs.writeFileSync(settingsFile, settings, { flag: 'wx' });

let launches = 0;
function start(exe, args, env = process.env) {
  const stdoutFile = path.join(target, `child-${++launches}-stdout.log`);
  const stderrFile = path.join(target, `child-${launches}-stderr.log`);
  const stdout = fs.openSync(stdoutFile, 'wx'), stderr = fs.openSync(stderrFile, 'wx');
  let child;
  try { child = spawn(exe, args, { cwd: target, env, windowsHide: true, stdio: ['ignore', stdout, stderr] }); }
  finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  // The viewer outlives the launcher and may inherit its standard handles.
  const result = once(child, 'exit').then(([code]) => ({ code, stdout: fs.readFileSync(stdoutFile, 'utf8'), stderr: fs.readFileSync(stderrFile, 'utf8') }));
  return { child, result };
}

const shell = (args, env) => start('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], env).result;
const assertSuccess = result => assert.equal(result.code, 0, result.stdout + result.stderr);
const preflightStart = performance.now();
const preflight = await shell(['-File', path.join(root, 'scripts', 'upgrade-windows.ps1'), '-Preflight'], { ...process.env, ProgramFiles: programFiles });
assertSuccess(preflight);
assert.match(preflight.stdout, /"historyMode":\s*"verified-plain"/);
assert.match(preflight.stdout, /"legacyPasswordRequired":\s*false/);
assert.match(preflight.stdout, /"migrationSpace":\s*0/);
const preflightMs = Math.round(performance.now() - preflightStart);

const stageTime = performance.now();
const copy = await shell(['-Command', "$ErrorActionPreference='Stop'; . $env:TW_SMOKE_COPY; Copy-TrafficWatchUpgradeStage $env:TW_SMOKE_PACKAGE $env:TW_SMOKE_INSTALLED $env:TW_SMOKE_STAGE"], {
  ...process.env, TW_SMOKE_COPY: path.join(root, 'scripts', 'upgrade-program.ps1'), TW_SMOKE_PACKAGE: root,
  TW_SMOKE_INSTALLED: installed, TW_SMOKE_STAGE: staged,
});
assertSuccess(copy);
const stagedMs = Math.round(performance.now() - stageTime);
fs.renameSync(installed, rollback);
fs.renameSync(staged, installed);
assert.equal(fs.readFileSync(settingsFile, 'utf8'), settings);
assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'))).version, version);

const listen = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
let foreignRequests = 0;
const foreign = http.createServer((_, response) => { foreignRequests++; response.writeHead(418).end(); });
const reserved = [http.createServer(), http.createServer(), http.createServer()];
const [viewPort, machinePort, clashPort, foreignPort] = await Promise.all([...reserved, foreign].map(listen));
await Promise.all(reserved.map(close));
assert.ok(![43128, 43130, 43131, 43132, 3425].includes(viewPort));
const env = { ...process.env, NETWATCH_TEST_SILENT: '1', TRAFFICWATCH_OVERVIEW_PORT: String(viewPort),
  TRAFFICWATCH_DATA_ROOT: dataRoot, TRAFFICWATCH_CACHE_ROOT: path.join(target, 'cache'), TRAFFICWATCH_OVERVIEW_LOG: log,
  TRAFFICWATCH_MACHINE_PORT: String(machinePort), TRAFFICWATCH_CLASH_PORT: String(clashPort), TRAFFICWATCH_SINGLE_COLLECTOR: '0' };
const control = (...args) => start(path.join(installed, 'TrafficWatch-Control.exe'), args, env).result;
const tray = (...args) => start(path.join(installed, 'TrafficWatch-Tray.exe'), ['--attach-suite', ...args], env);
const url = `http://127.0.0.1:${viewPort}`;
const headers = { 'x-codex-flow': '1', connection: 'close' };
const get = (route, timeout = 2500) => fetch(url + route, { headers, signal: AbortSignal.timeout(timeout) });
async function health() {
  try { return await (await get('/api/health', 800)).json(); }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED') return null; throw error; }
}
async function until(check) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error('Smoke check timed out');
}
const starts = () => (fs.readFileSync(log, 'utf8').match(/\[launcher\] starting viewer port=/g) || []).length;
let childTray, lastPid;
async function stopViewer() {
  const info = await health();
  if (!info) return;
  assert.equal(info.app, 'trafficwatch-overview');
  assert.equal(info.version, version);
  if (lastPid) assert.equal(info.collectorPid, lastPid);
  const response = await fetch(url + '/api/stop', { method: 'POST', headers, signal: AbortSignal.timeout(2500) });
  assert.equal(response.status, 200);
  await until(async () => !(await health()));
  lastPid = undefined;
}

try {
  const coldStart = performance.now();
  childTray = tray('--no-browser');
  for (const result of await Promise.all([control('--overview'), control(), control('--ensure-overview')])) assertSuccess(result);
  const first = await until(health);
  const coldMs = Math.round(performance.now() - coldStart);
  assert.equal(first.version, version);
  assert.equal(first.storage, 'sqlite-wal');
  assert.equal(first.singleCollector, null);
  lastPid = first.collectorPid;
  assert.equal(starts(), 1, 'Concurrent entry points must launch one viewer');

  const warm = performance.now();
  assertSuccess(await control('--overview'));
  const reuseMs = Math.round(performance.now() - warm);
  assert.equal((await health()).collectorPid, lastPid);
  const html = await get('/');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<title>[^<]*TrafficWatch|id="overviewMachine"/);
  const queryStart = performance.now();
  const overview = await get('/api/overview?range=today&quick=1', 20000);
  assert.equal(overview.status, 200);
  const summary = await overview.json();
  assert.equal(summary.machine.available, true);
  assert.equal(summary.clash.available, true);
  const realQueryMs = Math.round(performance.now() - queryStart);

  await stopViewer();
  assertSuccess(await tray().result); // Second tray process signals the existing tray's Open action.
  const reopened = await until(health);
  lastPid = reopened.collectorPid;
  assert.notEqual(lastPid, first.collectorPid);
  await until(() => starts() === 2);
  assertSuccess(await tray('--exit').result);
  assertSuccess(await childTray.result);
  const collision = await start(path.join(installed, 'TrafficWatch-Control.exe'), ['--ensure-overview'], {
    ...env, TRAFFICWATCH_OVERVIEW_PORT: String(foreignPort),
  }).result;
  assert.equal(collision.code, 1, collision.stdout + collision.stderr);
  assert.match(collision.stderr, /HTTP 418/);
  assert.equal(foreignRequests, 1);
  assert.equal(starts(), 2, 'A foreign listener must not spawn a second process');

  const bindFailure = await start(path.join(installed, 'runtime', 'node.exe'), ['--disable-warning=ExperimentalWarning', path.join(installed, 'src', 'overview-server.mjs')], {
    ...env, TRAFFICWATCH_OVERVIEW_PORT: String(foreignPort),
  }).result;
  assert.equal(bindFailure.code, 1, bindFailure.stdout + bindFailure.stderr);
  assert.match(bindFailure.stderr, /EADDRINUSE/);
  assert.match(fs.readFileSync(log, 'utf8'), /\[viewer\][^\r\n]+EADDRINUSE/);

  await stopViewer();
  fs.writeFileSync(settingsFile, '{');
  try {
    const crashed = await control('--ensure-overview');
    assert.equal(crashed.code, 1, crashed.stdout + crashed.stderr);
    assert.match(fs.readFileSync(log, 'utf8'), /invalid settings JSON[\s\S]*\[launcher\] port=\d+[^\r\n]+1/);
    assert.equal(await health(), null);
  } finally { fs.writeFileSync(settingsFile, settings); }
  console.log(JSON.stringify({ status: 'passed', preflightMs, stagedMs, coldMs, reuseMs, realQueryMs, firstPid: first.collectorPid, reopenedPid: reopened.collectorPid, viewPort, foreignPort }));
} finally {
  if (childTray && childTray.child.exitCode === null) {
    assertSuccess(await tray('--exit').result);
    assertSuccess(await childTray.result);
  }
  await stopViewer();
  await close(foreign);
}

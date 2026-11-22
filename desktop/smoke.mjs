import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('The portable smoke test requires Windows.');
const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../.build/windows/TrafficWatch', import.meta.url)));
const exe = path.join(root, 'Codex-Netwatch.exe');
assert.ok(fs.existsSync(exe), 'Build the portable ZIP before running this test.');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-portable-'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
let env, port, host, observedToken, smokeError, lastProbe, stage;
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
function overviewPort(port) { return port === 43129 ? 43139 : port === 65535 ? port - 1 : port + 1; }
async function freePorts() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const collector = http.createServer(), overview = http.createServer();
    const candidate = await listen(collector, 0);
    try {
      await listen(overview, overviewPort(candidate));
      await close(overview);
      return candidate;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      console.log(`Selecting another port pair: ${error.message}`);
    } finally { await close(collector); }
  }
  throw new Error('No free pair of collector and overview ports');
}
function launch(args = []) {
  const child = spawn(exe, ['--demo', '--no-browser', ...args], {
    cwd: root,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  return child;
}
async function command(name) {
  const child = launch([name]);
  await expectExit(child, `Tray control ${name}`);
}
async function expectExit(child, label) {
  let code = child.exitCode;
  if (code === null && !child.signalCode) {
    try { [code] = await once(child, 'exit', { signal: AbortSignal.timeout(12000) }); }
    catch (error) { throw new Error(`${label} did not exit: ${error.message}`, { cause: error }); }
  }
  assert.equal(code, 0, `${label} exit code`);
}
function request(port, route, init = {}, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: init.method, headers: init.headers,
      agent: false, signal: AbortSignal.timeout(timeout),
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once('error', reject);
    req.end(init.body);
  });
}
async function health() {
  try {
    const result = await request(port, '/api/health', {}, 1000);
    if (result.status === 200) { lastProbe = undefined; return JSON.parse(result.body); }
    lastProbe = `HTTP ${result.status}`;
  } catch (error) {
    lastProbe = error.code || error.message;
    return null;
  }
  return null;
}
async function until(predicate, message, duration = 20000) {
  const end = Date.now() + duration;
  while (Date.now() < end) {
    if (await predicate()) return;
    await pause(100);
  }
  throw new Error(`${message}${lastProbe ? ` (${lastProbe})` : ''}`);
}
const step = message => { stage = message; console.log(`Portable smoke: ${message}`); };
try {
  stage = 'select test ports';
  port = await freePorts();
  env = { ...process.env, NETWATCH_TEST_SILENT: '1', CODEX_FLOW_PORT: String(port), CODEX_FLOW_DATA_DIR: data };
  const viewPort = overviewPort(port);
  step(`start isolated demo on ${port}, overview on ${viewPort}`);
  host = launch();
  let first;
  await until(async () => {
    first = await health();
    return first?.startupStage === 'ready' && first.state === 'connected' && /^[a-f0-9]{64}$/.test(first.desktopInstance || '');
  },
    'Desktop collector readiness timeout',
  );
  observedToken = first.desktopInstance;
  assert.equal(first.demo, true);
  assert.equal(first.app, 'codex-flow');
  assert.ok(fs.existsSync(path.join(data, 'demo', 'monitor.sqlite')));
  step('reject stop without ownership token');
  const result = await request(port, '/api/stop', {
    method: 'POST',
    headers: { 'X-Codex-Flow': '1' },
    body: '{}',
  });
  assert.equal(result.status, 403, 'Desktop stop must reject requests without the ownership token');
  step('verify single instance and launch overview');
  const duplicate = launch();
  await expectExit(duplicate, 'Duplicate launch');
  assert.equal((await health()).desktopInstance, first.desktopInstance);
  const open = spawn(exe, ['--demo'], { cwd:root,env,stdio:'ignore',windowsHide:true });
  children.push(open);
  await expectExit(open, 'Open overview');
  const viewBase=`http://127.0.0.1:${viewPort}`;
  const redirect=await request(port,'/');
  assert.equal(redirect.status,302);
  assert.equal(redirect.headers.location,viewBase+'/');
  await until(async()=>{
    try {
      const response = await request(viewPort, '/api/health', {}, 800);
      const info = JSON.parse(response.body);
      lastProbe = `${info.app || 'unknown app'} (HTTP ${response.status})`;
      return response.status === 200 && info.app === 'trafficwatch-overview' && info.singleCollector === 'demo';
    } catch (error) { lastProbe = error.code || error.message; return false; }
  },'Portable overview did not start',8000);
  step('read the demo data in the overview');
  let overviewResponse;
  try {
    overviewResponse = await request(viewPort, '/api/overview?range=24h', { headers: { 'x-codex-flow': '1' } });
  } catch (error) {
    const results = await Promise.allSettled([request(viewPort, '/api/health'),
      request(viewPort, '/api/overview-progress?range=24h', { headers: { 'x-codex-flow': '1' } }),
      request(port, '/api/harness-apps', { headers: { 'x-codex-flow': '1' } })
    ].map(async probe => JSON.parse((await probe).body)));
    console.error('Overview diagnostics after timeout:', JSON.stringify(results));
    throw error;
  }
  assert.equal(overviewResponse.status,200);
  const overview=JSON.parse(overviewResponse.body);
  assert.equal(overview.machine.available,true);assert.equal(overview.clash.available,false);
  assert.equal(overview.live.singleCollector,'demo');assert.equal(overview.live.installedControls,false);
  step('stop and restart the collector');
  await command('--stop');
  await until(async () => !(await health()), 'Tray stop did not stop collector');
  assert.equal(host.exitCode, null, 'Stopping collector must retain the tray');
  // Closing the listening socket precedes the process-exit lock cleanup.
  // Wait for that separate completion condition before attempting a restart.
  await until(
    () => !fs.existsSync(path.join(data, 'demo', 'collector.lock')),
    'Stopped collector did not release its data-directory lock',
    6000,
  );
  await command('--start');
  await until(async () => {
    const restarted = await health();
    return restarted?.startupStage === 'ready' && restarted.state === 'connected' && restarted.desktopInstance === first.desktopInstance;
  },
    'Tray restart failed',
  );
  step('exit tray and confirm collector stops');
  await command('--exit');
  await expectExit(host, 'Portable tray');
  await until(async () => !(await health()), 'Exiting tray left collector running');
  await until(
    () => !fs.existsSync(path.join(data, 'demo', 'collector.lock')),
    'Exited collector did not release its data-directory lock',
    6000,
  );
  await until(async () => {
    try {
      const response = await request(viewPort, '/api/health', {}, 800);
      lastProbe = `HTTP ${response.status}`;
      return false;
    } catch (error) {
      lastProbe = error.code || error.message;
      return error.code === 'ECONNREFUSED';
    }
  }, 'Exiting tray left its overview listening', 6000);

  step('ensure the tray never stops a foreign listener');
  let stopRequests = 0;
  const foreign = http.createServer((req, res) => {
    if (req.url === '/api/stop') stopRequests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        app: 'codex-flow',
        version: 'foreign-test',
        demo: true,
        desktopInstance: 'foreign-owner',
      }),
    );
  });
  await listen(foreign, port);
  try {
    const attached = host = launch();
    // The foreign HTTP server is already ready; give the tray time to construct its controls.
    await pause(1000);
    await command('--stop');
    assert.equal(stopRequests, 0, 'Tray must never stop a pre-existing HTTP service');
    await command('--exit');
    await expectExit(attached, 'Tray attached to foreign listener');
    assert.equal(stopRequests, 0);
    assert.equal((await health()).desktopInstance, 'foreign-owner');
  } finally {
    await close(foreign);
  }
  console.log(
    'Portable smoke: bundled runtime, own collector startup/stop/restart/exit, single instance, overview redirect and isolated demo data, lock cleanup, and foreign-service safety passed.',
  );
} catch (error) {
  smokeError = new Error(`Portable smoke failed at "${stage}": ${error.message}`, { cause: error });
  const log = path.join(data, 'demo', 'tray.log');
  if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').trimEnd());
  throw smokeError;
} finally {
  // Signal the exact tray/data-directory group before terminating any remaining test hosts.
  if (env && children.some(child => child.exitCode === null && !child.signalCode)) {
    try { await command('--exit'); if (host) await expectExit(host, 'Test tray cleanup'); }
    catch (error) { console.error(`Test tray cleanup: ${error.message}`); }
  }
  if (observedToken && (await health())?.desktopInstance === observedToken) {
    try {
      const stopped = await request(port, '/api/stop', {
        method: 'POST',
        headers: { 'X-Codex-Flow': '1', 'X-Codex-Desktop-Token': observedToken },
        body: '{}',
      }, 2000);
      assert.equal(stopped.status, 200);
      await until(async () => !(await health()), 'Test collector cleanup failed', 6000);
    } catch (error) { console.error(`Test collector cleanup: ${error.message}`); }
  }
  for (const child of children) if (child.exitCode === null) child.kill();
  await pause(150);
  assert.equal(path.dirname(fs.realpathSync(data)), fs.realpathSync(os.tmpdir()), 'Test data must remain inside the temporary directory');
  try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }
  catch (error) {
    if (!smokeError) throw error;
    console.error(`Test cleanup also failed: ${error.code}`);
  }
}

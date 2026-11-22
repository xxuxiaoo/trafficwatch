import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { Accounting } from '../src/accounting.mjs';
import { ANTIGRAVITY_BUNDLE_ROOT, normalizeHarnessApps } from '../src/harness.mjs';
import { Monitor } from '../src/monitor.mjs';
import { startOverviewServer } from '../src/overview-server.mjs';
import { createServer } from '../src/server.mjs';
import { antigravityObserver, bundlePath, config, nativeIdentity, recordAntigravity } from './antigravity-fixture.mjs';
import { assertBytes, connection, fixture, record } from './history-synthetic-fixtures.mjs';

const now = Date.parse('2026-01-12T04:00:00Z');

test('Antigravity defaults work with older aliases and generic processes cannot be Antigravity aliases', () => {
  assert.deepEqual(normalizeHarnessApps({ claude: ['custom-claude.exe'] }).antigravity, ['antigravity.exe', 'antigravity']);
  const oldRules = normalizeHarnessApps({ dsh: ['Antigravity.exe'] });
  assert.deepEqual(oldRules.dsh, ['antigravity.exe']);
  assert.deepEqual(oldRules.antigravity, ['antigravity']);
  assert.throws(() => normalizeHarnessApps({ antigravity: ['antigravity.exe'], dsh: ['antigravity.exe'] }), /cannot belong to two/);
  for (const name of ['node.exe', 'powershell.exe', 'language_server.exe', 'LANGUAGE_SERVER_WINDOWS_X64.EXE']) {
    assert.throws(() => normalizeHarnessApps({ antigravity: [name] }), /require/, name);
  }
});

test('native Antigravity recognition preserves verified ancestry and does not absorb nested Codex or a namesake', () => {
  const observer = antigravityObserver(now);
  const classify = (pid, at = now) => observer.classify(nativeIdentity(observer, pid), at);
  assert.equal(classify(10).family, 'antigravity');
  assert.deepEqual(classify(11), { scope: 'other', family: 'antigravity', familyRoot: ANTIGRAVITY_BUNDLE_ROOT, evidence: 'etw', process: 'language_server.exe', pid: 11 });
  assert.deepEqual(classify(12), { scope: 'other', family: 'antigravity', familyRoot: ANTIGRAVITY_BUNDLE_ROOT, evidence: 'etw_descendant', process: 'node.exe', pid: 12 });
  assert.equal(classify(13).family, 'codex');
  assert.equal(classify(14).family, 'other');
  assert.equal(classify(11, now + 6001).family, 'other');
  assert.equal(observer.classify({ ...nativeIdentity(observer, 12), processBorn: now - 5000 }, now).family, 'other');

  const server = observer.processes.get(11);
  server.path = null;
  assert.equal(classify(11).evidence, 'etw_descendant');
  observer.config.includeDescendants = false;
  assert.equal(classify(11).family, 'other');
  observer.config.includeDescendants = true;
  observer.processes.get(10).born = 0;
  assert.equal(classify(11).family, 'other');
  observer.processes.get(10).born = now - 5000;
  assert.equal(classify(11).family, 'other');
});

test('Clash uses a bundled image path or an unambiguous socket, not the destination hostname', () => {
  const observer = antigravityObserver(now);
  const metadata = { network: 'tcp', sourcePort: 50441, sourceIP: '127.0.0.1', host: 'agent.example.test' };
  assert.equal(observer.classify({ ...metadata, process: 'Antigravity.exe' }, now).family, 'antigravity');
  assert.equal(observer.classify({ ...metadata, process: 'msedge.exe' }, now).family, 'other');
  assert.equal(observer.classify({ ...metadata, process: 'language_server.exe' }, now).family, 'other');
  assert.equal(observer.classify({ ...metadata, process: 'language_server.exe', processPath: bundlePath.replace('Antigravity', 'OtherAntigravity') }, now).family, 'other');
  assert.equal(observer.classify({ ...metadata, process: 'unrelated.exe', processPath: bundlePath }, now).family, 'other');
  for (const processPath of [bundlePath, bundlePath.replace('language_server.exe', 'language_server_windows_x64.exe')]) {
    const proof = observer.classify({ ...metadata, process: processPath }, now);
    assert.equal(proof.family, 'antigravity');
    assert.match(proof.process, /^language_server(?:_windows_x64)?\.exe$/);
    assert.equal(proof.familyRoot, ANTIGRAVITY_BUNDLE_ROOT);
    assert.doesNotMatch(JSON.stringify(proof), /SyntheticApps|processPath/);
  }
  const helper = { ...metadata, process: 'node.exe' };
  observer.sockets.set('tcp:50441', [{ ip: '127.0.0.1', pid: 12 }]);
  assert.equal(observer.classify(helper, now).evidence, 'descendant');
  assert.equal(observer.classify(helper, now + 6001).family, 'other');
  assert.equal(observer.classify({ ...helper, process: 'msedge.exe' }, now).family, 'other');
  observer.sockets.get('tcp:50441').push({ ip: '127.0.0.1', pid: 13 });
  assert.equal(observer.classify(helper, now).family, 'other');
});

test('later process evidence is kept for a stable connection when the observer briefly goes stale', () => {
  const observer = antigravityObserver(now);
  const accounting = new Accounting();
  const metadata = { process: 'node.exe', network: 'tcp', sourcePort: 50441, sourceIP: '127.0.0.1' };
  const sample = (offset, total) => accounting.consume({
    uploadTotal: total, downloadTotal: total * 2,
    connections: [{ id: 'stable-connection', start: new Date(now - 1000).toISOString(), metadata, upload: total, download: total * 2 }],
  }, now + offset, (value, at) => observer.classify(value, at));
  assert.equal(sample(0, 12).rows[0].family, 'other');
  observer.sockets.set('tcp:50441', [{ ip: '127.0.0.1', pid: 12 }]);
  const established = sample(1000, 17).rows[0];
  assert.deepEqual([established.family, established.evidence, established.pid], ['antigravity', 'descendant', 12]);
  const stale = sample(7000, 23).rows[0];
  assert.equal(stale.family, 'antigravity');
  assertBytes(stale, 6, 12);
});

const listen = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('Antigravity totals, process and proxy detail, and alias edits use the actual HTTP and SQLite layers', { timeout: 20000 }, async t => {
  const f = fixture(t), windows = f.open('windows'), clash = f.open('clash');
  const at = Math.floor((Date.now() - 180000) / 60000) * 60000;
  const oldApps = { codex: ['codex.exe'], claude: ['claude.exe'], dsh: ['dsh.exe'] };
  for (const store of [windows, clash]) store.setHarnessApps(oldApps);
  record(windows, at - 60000, [
    connection('legacy-main', 100, 200, { process: 'Antigravity.exe' }),
    connection('legacy-ambiguous', 800, 900, { process: 'language_server.exe' }),
    connection('legacy-unknown', 400, 500, { process: 'Antigravity.exe', scope: 'unknown' }),
    connection('optional-alias', 600, 900, { process: 'alternate-antigravity.exe' }),
  ]);
  recordAntigravity(windows, clash, at);
  const settings = config({ root: path.resolve(import.meta.dirname, '..'), demo: true, codexHome: f.root });
  const collectors = [windows, clash].map(store => {
    const collectorConfig = { ...settings };
    return createServer(collectorConfig, store, new Monitor(collectorConfig, store), () => {});
  });
  const reserved = net.createServer(), port = await listen(reserved);
  await close(reserved);
  const sourcePorts = await Promise.all(collectors.map(listen));
  const app = startOverviewServer({ historyRoot: f.root, suiteSettings: {}, listenPort: port, sourcePorts });
  try {
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${port}`;
    const query = (route, init = {}) => fetch(base + route, {
      signal: AbortSignal.timeout(10000), ...init, headers: { 'x-codex-flow': '1', ...init.headers },
    });
    const get = async route => {
      const response = await query(route);
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const overview = await get('/api/overview?range=24h');
    assertBytes(overview.machine.familyTotals.antigravity, 7100, 11200);
    assertBytes(overview.machine.familyTotals.codex, 6000, 4000);
    assertBytes(overview.machine.familyTotals.unknown, 400, 500);
    assertBytes(overview.machine.totals, 22900, 26500);
    assertBytes(overview.clash.familyTotals.antigravity, 4000, 8000);
    assertBytes(overview.clash.groups.proxy, 4000, 8000);

    const local = await get('/api/harness?lane=windows&family=antigravity&range=24h');
    assertBytes(local.summary, 7100, 11200);
    assert.equal(local.summary.connections, 4);
    const proxy = await get('/api/harness?lane=clash&family=antigravity&range=24h');
    assertBytes(proxy.summary, 3000, 6000);
    assertBytes(proxy.routeTotals.proxy, 3000, 6000);
    const processDetails = await get('/api/detail?lane=windows&family=antigravity&range=24h&process=language_server.exe');
    assert.deepEqual(processDetails.connections.map(row => [row.process, row.host, row.up, row.down]), [['language_server.exe', 'agent.example.test', 4000, 6000]]);
    const proxyDetails = await get(`/api/detail?lane=clash&family=antigravity&route=proxy&range=24h&from=${at}&to=${at + 60000}`);
    assert.deepEqual(proxyDetails.connections.map(row => [row.client, row.node, row.destinationPort]), [['verge', 'Example node', 443]]);
    assertBytes(proxyDetails.summary, 3000, 6000);
    for (const value of ['language_server', 'unknown', '']) {
      const rejected = await query(`/api/harness?family=${value}`);
      assert.equal(rejected.status, 400);
      assert.deepEqual(await rejected.json(), { error: 'invalid_family' });
    }
    assert.equal((await fetch(`${base}/api/harness?family=antigravity`)).status, 403);
    assert.doesNotMatch(JSON.stringify([overview, local, proxyDetails]), /SyntheticApps|processPath|bundle:antigravity/);
    assert.equal(windows.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);

    const apps = (await get('/api/harness-apps')).apps;
    const save = antigravity => query('/api/harness-apps', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apps: { ...apps, antigravity } }),
    });
    assert.equal((await save([...apps.antigravity, 'language_server.exe'])).status, 400);
    const edited = [...apps.antigravity, 'alternate-antigravity.exe'];
    const response = await save(edited);
    assert.equal(response.status, 200, response.statusText);
    assert.deepEqual((await response.json()).apps.antigravity, edited);
    for (const store of [windows, clash]) assert.deepEqual(store.get('harnessApps').antigravity, edited);
    assertBytes((await get('/api/harness?lane=windows&family=antigravity&range=24h')).summary, 7700, 12100);
  } finally {
    await app.close();
    await Promise.all(collectors.map(close));
  }
});

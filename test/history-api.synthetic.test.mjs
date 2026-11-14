import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Accounting } from '../src/accounting.mjs';
import { DEFAULT_CODEX_PROCESS_NAMES } from '../src/harness.mjs';
import { overviewRange, readDetail, readLane } from '../src/overview-data.mjs';
import { BASE, MINUTE, assertBytes, bytes, connection, fixture, record, rule } from './history-synthetic-fixtures.mjs';

const DAY = 24 * 60 * MINUTE;
const now = BASE + 60 * MINUTE;
const window = { from: BASE, to: BASE + 10 * MINUTE };
const apps = (dsh = ['dsh.exe'], claude = ['claude.exe']) => ({
  codex: [...DEFAULT_CODEX_PROCESS_NAMES], claude, dsh,
});

test('overviewRange uses Shanghai calendar boundaries and exclusive day ends', () => {
  const at = Date.parse('2026-11-13T02:03:45.678Z');
  const firstAt = Date.parse('2026-11-01T13:14:15.678Z');
  const today = overviewRange('today', at, firstAt);
  assert.equal(today.from, Date.parse('2026-11-12T16:00:00Z'));
  assert.equal(today.to, at);
  assert.equal(today.timeZone, 'Asia/Shanghai');
  assert.equal(overviewRange('month', at, firstAt).from, Date.parse('2026-10-31T16:00:00Z'));
  const past = overviewRange('day', at, firstAt, '2026-11-11');
  assert.equal(past.from, Date.parse('2026-11-10T16:00:00Z'));
  assert.equal(past.to, Date.parse('2026-11-11T16:00:00Z'));
  assert.equal(past.to - past.from, DAY);
  assert.equal(overviewRange('day', at, firstAt, '2026-11-13').to, at);
  assert.equal(overviewRange('all', at, firstAt).from, Date.parse('2026-11-01T13:14:00Z'));
  assert.equal(overviewRange('all', at, null).from, Date.parse('2026-11-13T02:03:00Z'));
  for (const [name, days] of [['24h', 1], ['7d', 7], ['30d', 30]]) {
    const range = overviewRange(name, at, firstAt);
    assert.equal(range.from, Math.floor((at - days * DAY) / MINUTE) * MINUTE, name);
    assert.equal(range.to, at, name);
  }
});

test('overviewRange rejects invalid calendar dates, future dates, and unknown ranges', () => {
  const at = Date.parse('2026-11-13T02:03:00Z');
  for (const date of [undefined, '', '2026-2-01', '2026-02-30', '2026-13-01', '2026-11-14']) {
    assert.throws(() => overviewRange('day', at, null, date), RangeError, String(date));
  }
  for (const name of ['', 'custom', '90d', '__proto__']) {
    assert.throws(() => overviewRange(name, at, null), RangeError, name);
  }
});

test('missing lanes are unavailable without creating a database', (t) => {
  const { root } = fixture(t);
  for (const lane of ['windows', 'clash']) {
    for (const read of [readLane, readDetail]) {
      const result = read(root, lane, 'all', now);
      assert.equal(result.available, false);
      assert.equal(result.error, 'missing_database');
    }
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

for (const lane of ['windows', 'clash']) {
  test(`${lane}: overview and detail share family and connection byte totals`, (t) => {
    const f = fixture(t), store = f.open(lane);
    const source = lane === 'windows' ? 'windows' : 'mihomo';
    record(store, BASE + 1000, [
      connection('proxy', 11, 101, { process: 'codex.exe', scope: 'codex', family: 'codex', familyRoot: 'codex.exe', rule: rule(['Synthetic proxy', 'DIRECT'], { source }) }),
      connection('direct', 7, 70, { process: 'claude.exe', family: 'claude', familyRoot: 'claude.exe', rule: rule([' DIRECT ', 'Proxy group'], { source }) }),
      connection('blocked', 3, 30, { process: '', pid: null, scope: 'unknown', evidence: 'none', family: 'unknown', rule: rule(['REJECT-DROP'], { source }) }),
      connection('legacy', 5, 50, { process: 'dsh.exe', family: 'dsh', familyRoot: 'dsh.exe' }),
    ], { allUp: 29, allDown: 281 });
    const overview = readLane(f.root, lane, 'all', now, window);
    const detail = readDetail(f.root, lane, 'all', now, window);
    assert.equal(overview.available, true);
    assert.equal(detail.available, true);
    assertBytes(overview.totals, 29, 281);
    assertBytes(detail.summary, 26, 251);
    assert.equal(detail.summary.connections, 4);
    for (const list of [overview.allPrograms, detail.connections, detail.processes, detail.destinations, detail.series]) {
      assertBytes(bytes(list), 26, 251);
    }
    assertBytes(bytes(overview.timeline), 29, 281);
    assertBytes(overview.unassigned, 3, 30);
    assert.equal(overview.connectionCountersExceedGlobal, false);
    for (const [family, up, down] of [['codex', 11, 101], ['claude', 7, 70], ['dsh', 5, 50], ['unknown', 3, 30]]) {
      assertBytes(overview.familyTotals[family], up, down, family);
    }
    if (lane === 'clash') {
      assertBytes(overview.groups.proxy, 11, 101);
      assertBytes(overview.groups.direct, 7, 70);
      assertBytes(overview.groups.unknown, 8, 80);
      assert.deepEqual(detail.routeTotals, overview.groups);
      for (const route of ['proxy', 'direct', 'unknown']) {
        assert.deepEqual(bytes(overview.routePrograms[route]), overview.groups[route]);
        const filtered = readDetail(f.root, lane, 'all', now, { ...window, route });
        assert.deepEqual({ up: filtered.summary.up, down: filtered.summary.down }, overview.groups[route]);
      }
      assertBytes(bytes(overview.programs), 11, 101);
      assertBytes(bytes(overview.domains), 11, 101);
      assertBytes(bytes(overview.routeTimeline), 26, 251);
      const proxy = detail.connections.find((row) => row.id === 'proxy');
      assert.equal(proxy.route, 'proxy', 'route comes from the leaf, not a later DIRECT group');
      assert.equal(proxy.destinationIP, '192.0.2.10');
      assert.equal(proxy.destinationPort, 443);
      assert.equal(proxy.localPort, 50_001);
      assert.deepEqual(proxy.chain, ['Synthetic proxy', 'DIRECT']);
    } else {
      assertBytes(bytes(overview.programs), 26, 251);
      assert.deepEqual(overview.groups, { proxy: { up: 0, down: 0 }, direct: { up: 0, down: 0 }, unknown: { up: 0, down: 0 } });
    }
  });

  test(`${lane}: clicking a five-minute peak excludes the next bucket exactly once`, (t) => {
    const f = fixture(t), store = f.open(lane);
    const metadata = { rule: rule(['Synthetic proxy'], { source: lane === 'clash' ? 'mihomo' : 'windows' }) };
    for (const [at, id, up] of [
      [BASE - MINUTE + 1000, 'before', 1],
      [BASE, 'start', 10],
      [BASE + 5 * MINUTE - 1, 'last-in-peak', 20],
      [BASE + 5 * MINUTE, 'at-exclusive-end', 1000],
      [BASE + 6 * MINUTE + 1000, 'after', 2000],
    ]) record(store, at, [connection(id, up, up * 10, metadata)]);
    const overview = readLane(f.root, lane, 'all', now);
    const peak = overview.peaks.find((row) => row.at === BASE);
    assertBytes(peak, 30, 300);
    const selection = { from: peak.at, to: peak.at + 5 * MINUTE };
    const clicked = readDetail(f.root, lane, 'all', now, selection);
    const selectedOverview = readLane(f.root, lane, 'all', now, selection);
    assert.equal(clicked.range.from, BASE);
    assert.equal(clicked.range.to, BASE + 5 * MINUTE);
    assertBytes(clicked.summary, 30, 300);
    assertBytes(selectedOverview.totals, 30, 300);
    assert.deepEqual(clicked.connections.map((row) => row.id).sort(), ['last-in-peak', 'start']);
    assert.ok(clicked.series.every((row) => row.at < selection.to));
    const next = readDetail(f.root, lane, 'all', now, { from: selection.to, to: selection.to + 5 * MINUTE });
    assertBytes(next.summary, 3000, 30_000);
    assert.deepEqual(next.connections.map((row) => row.id).sort(), ['after', 'at-exclusive-end']);
  });

  for (const family of ['codex', 'dsh']) {
    test(`${lane}: earlier unknown bytes stay anonymous after ${family} identification`, (t) => {
      const f = fixture(t), store = f.open(lane);
      const accounting = new Accounting({ preserveRouteMetadata: true });
      const processName = family === 'codex' ? 'codex.exe' : 'node.exe';
      const identity = { process: processName, pid: 202, scope: family === 'codex' ? 'codex' : 'other', family, familyRoot: family === 'codex' ? 'codex.exe' : 'script:dsh', evidence: 'process' };
      const snapshot = (up, down) => ({
        incremental: true, duration: 1000, uploadTotal: up, downloadTotal: down,
        connections: [{ id: 'same-connection', start: new Date(BASE).toISOString(), upload: up, download: down,
          chains: ['Synthetic proxy'], metadata: { native: lane === 'windows', host: 'shared.example.test', network: 'tcp' } }],
      });
      const earlier = accounting.consume(snapshot(13, 130), BASE + 1000, () => null);
      const later = accounting.consume(snapshot(17, 170), BASE + 2 * MINUTE + 1000, () => identity);
      assert.equal(earlier.unknownUp, 13);
      assert.equal(later.unknownUp, 0);
      assert.equal(later.codexUp, family === 'codex' ? 17 : 0);
      assert.equal(earlier.rows[0].key, later.rows[0].key);
      assert.equal(store.record(earlier), true);
      assert.equal(store.record(later), true);
      assert.equal(store.db.prepare('SELECT process FROM connections').get().process, processName);
      const overview = readLane(f.root, lane, 'all', now, window);
      assertBytes(overview.familyTotals.unknown, 13, 130);
      assertBytes(overview.familyTotals[family], 17, 170);
      const unknownProgram = overview.allPrograms.find((row) => row.scope === 'unknown');
      assert.equal(unknownProgram.process, '');
      assert.equal(unknownProgram.evidence, 'none');
      const all = readDetail(f.root, lane, 'all', now, window);
      assert.equal(all.connections.length, 2, 'one connection has two historical scope groups');
      assert.equal(all.summary.connections, 1, 'summary counts distinct connection identities');
      const unknown = readDetail(f.root, lane, 'all', now, { ...window, process: '__unknown__' });
      assertBytes(unknown.summary, 13, 130);
      assert.equal(unknown.connections.length, 1);
      assert.equal(unknown.connections[0].process, '');
      assert.equal(unknown.connections[0].pid, null);
      assert.equal(unknown.connections[0].evidence, 'none');
      assert.equal(unknown.connections[0].family, 'unknown');
      for (const filter of [{ family }, { process: processName }, { scope: identity.scope }]) {
        assertBytes(readDetail(f.root, lane, 'all', now, { ...window, ...filter }).summary, 17, 170);
      }
      const oldWindow = { from: BASE, to: BASE + MINUTE };
      assertBytes(readDetail(f.root, lane, 'all', now, { ...oldWindow, family }).summary, 0, 0);
      assertBytes(readLane(f.root, lane, 'all', now, oldWindow).familyTotals.unknown, 13, 130);
      const legacyUnknown = store.connections(BASE, now).find((row) => row.scope === 'unknown');
      assert.equal(legacyUnknown.process, '');
      assert.equal(legacyUnknown.pid, null);
      assert.equal(legacyUnknown.evidence, 'none');
    });
  }
}

test('detail summaries, series, and aggregates include every page after filtering', (t) => {
  const f = fixture(t), store = f.open('clash');
  const count = 205;
  const matching = Array.from({ length: count }, (_, i) => connection(`match-${String(i).padStart(3, '0')}`, i + 1, 2 * (i + 1), {
    host: 'dsh.example.test', process: 'dsh.exe', family: 'dsh', familyRoot: 'dsh.exe', rule: rule(),
  }));
  record(store, BASE + 1000, [...matching,
    connection('wrong-route', 1_000_000, 2_000_000, { process: 'dsh.exe', family: 'dsh', familyRoot: 'dsh.exe', host: 'dsh.example.test', rule: rule(['DIRECT']) }),
    connection('wrong-family', 3_000_000, 4_000_000, { host: 'dsh.example.test', rule: rule() }),
    connection('wrong-host', 5_000_000, 6_000_000, { process: 'dsh.exe', family: 'dsh', familyRoot: 'dsh.exe', rule: rule() }),
  ]);
  const options = { ...window, family: 'dsh', route: 'proxy', host: 'dsh.example.test' };
  const first = readDetail(f.root, 'clash', 'all', now, options);
  const up = count * (count + 1) / 2, down = up * 2;
  assert.equal(first.pagination.total, count);
  assert.ok(first.pagination.pageSize < count, 'fixture must cross a real page boundary');
  assert.equal(first.connections.length, first.pagination.pageSize);
  assert.ok(bytes(first.connections).up < up, 'first page intentionally omits measured bytes');
  const ids = new Set();
  const returned = [];
  const pageCount = Math.ceil(count / first.pagination.pageSize);
  for (let page = 0; page < pageCount; page++) {
    const detail = page === 0 ? first : readDetail(f.root, 'clash', 'all', now, { ...options, page });
    assert.equal(detail.pagination.page, page);
    assert.equal(detail.pagination.pages, pageCount);
    assert.equal(detail.pagination.total, count);
    assert.equal(detail.summary.connections, count);
    assertBytes(detail.summary, up, down, `page ${page} summary`);
    for (const list of [detail.series, detail.processes, detail.destinations, detail.nodes]) assertBytes(bytes(list), up, down);
    assertBytes(detail.routeTotals.proxy, up, down);
    assertBytes(detail.routeTotals.direct, 0, 0);
    for (const row of detail.connections) {
      assert.equal(ids.has(row.id), false, `duplicate across pages: ${row.id}`);
      ids.add(row.id);
      returned.push(row);
    }
  }
  assert.equal(ids.size, count);
  assertBytes(bytes(returned), up, down);
  const last = readDetail(f.root, 'clash', 'all', now, { ...options, page: 99_999 });
  assert.equal(last.pagination.page, pageCount - 1);
  assertBytes(last.summary, up, down);
  const empty = readDetail(f.root, 'clash', 'all', now, { ...options, host: 'absent.example.test' });
  assertBytes(empty.summary, 0, 0);
  assert.equal(empty.summary.connections, 0);
  assert.equal(empty.pagination.total, 0);
  assert.deepEqual(empty.connections, []);
});

test('current aliases override saved direct families; removed roots stop descendant attribution without backfill', (t) => {
  const f = fixture(t), store = f.open('windows');
  const previous = apps(['dsh.exe', 'retired-dsh.exe']);
  store.setHarnessApps(previous, BASE);
  record(store, BASE + 1000, [
    connection('retired-direct', 11, 110, { process: 'retired-dsh.exe', family: 'dsh', familyRoot: 'retired-dsh.exe' }),
    connection('retired-child', 13, 130, { process: 'helper.exe', family: 'dsh', familyRoot: 'retired-dsh.exe', evidence: 'descendant' }),
    connection('current-direct', 17, 170, { process: 'dsh.exe', family: 'dsh', familyRoot: 'dsh.exe' }),
    connection('verified-script', 19, 190, { process: 'node.exe', family: 'dsh', familyRoot: 'script:dsh' }),
    connection('new-alias', 23, 230, { process: 'new-dsh.exe' }),
  ]);
  assertBytes(readLane(f.root, 'windows', 'all', now, window).familyTotals.dsh, 60, 600);
  const saved = store.db.prepare('SELECT * FROM connection_families ORDER BY connection_id').all();
  const current = apps(['dsh.exe', 'new-dsh.exe']);
  store.setHarnessApps(current, BASE + MINUTE);
  assert.deepEqual(store.db.prepare('SELECT * FROM connection_families ORDER BY connection_id').all(), saved,
    'changing aliases must not rewrite historical family evidence');
  const overview = readLane(f.root, 'windows', 'all', now, window);
  assertBytes(overview.familyTotals.dsh, 59, 590);
  assertBytes(overview.familyTotals.other, 24, 240);
  const detail = readDetail(f.root, 'windows', 'all', now, { ...window, family: 'dsh' });
  assert.deepEqual(detail.connections.map((row) => row.id).sort(), ['current-direct', 'new-alias', 'verified-script']);
  const reassigned = apps(['dsh.exe', 'new-dsh.exe'], ['claude.exe', 'retired-dsh.exe']);
  const currentOverride = readDetail(f.root, 'windows', 'all', now, { ...window, family: 'claude', apps: reassigned });
  assert.deepEqual(currentOverride.connections.map((row) => row.id), ['retired-direct']);
  assertBytes(currentOverride.summary, 11, 110);
  assertBytes(readDetail(f.root, 'windows', 'all', now, { ...window, family: 'dsh', apps: reassigned }).summary, 59, 590);
});

test('Store additively opens a version-4 database without connection_families and preserves old history', (t) => {
  const f = fixture(t);
  let store = f.open('windows');
  record(store, BASE + 1000, [connection('old-claude', 31, 310, { process: 'claude.exe' })]);
  store.setHarnessApps(apps());
  store.set('synthetic-sentinel', { retained: true });
  const before = {
    samples: store.db.prepare('SELECT * FROM samples').all(),
    buckets: store.db.prepare('SELECT * FROM buckets').all(),
    connections: store.db.prepare('SELECT * FROM connections').all(),
    ledger: store.db.prepare('SELECT * FROM daily_usage').all(),
  };
  // Make the legacy fixture from the built-in Store, without copying its schema.
  store.db.exec('DROP TABLE connection_families; PRAGMA user_version=4;');
  f.close(store);
  const legacyOverview = readLane(f.root, 'windows', 'all', now, window);
  assertBytes(legacyOverview.familyTotals.claude, 31, 310);
  assertBytes(readDetail(f.root, 'windows', 'all', now, { ...window, family: 'claude' }).summary, 31, 310);
  store = f.open('windows');
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.deepEqual(store.db.prepare('PRAGMA table_info(connection_families)').all().map((row) => row.name),
    ['connection_id', 'family', 'root_process', 'updated_at']);
  assert.deepEqual(store.get('synthetic-sentinel'), { retained: true });
  for (const [table, saved] of [['samples', before.samples], ['buckets', before.buckets], ['connections', before.connections], ['daily_usage', before.ledger]]) {
    assert.deepEqual(store.db.prepare(`SELECT * FROM ${table}`).all(), saved, `${table} survives additive migration`);
  }
  record(store, BASE + 2 * MINUTE + 1000, [connection('new-script', 37, 370, { process: 'node.exe', family: 'dsh', familyRoot: 'script:dsh', evidence: 'descendant' })]);
  const family = store.db.prepare('SELECT * FROM connection_families WHERE connection_id=?').get('new-script');
  assert.equal(family.family, 'dsh');
  assert.equal(family.root_process, 'script:dsh');
  assert.equal(family.updated_at, BASE + 2 * MINUTE + 1000);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  f.close(store);
  store = f.open('windows');
  const totals = store.totals(BASE, now);
  assert.equal(totals.all_up, 68);
  assert.equal(totals.all_down, 680);
  const migrated = readLane(f.root, 'windows', 'all', now, window);
  assertBytes(migrated.familyTotals.claude, 31, 310);
  assertBytes(migrated.familyTotals.dsh, 37, 370);
  assertBytes(readDetail(f.root, 'windows', 'all', now, window).summary, 68, 680);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normalizeGrant, GrantRegistry, restrictReadConnection } from '../src/vault-grants.mjs';

const now = Date.parse('2026-11-14T12:00:00+08:00');
const selected = { name: 'synthetic AI', lanes: ['clash'], permissions: ['read'], minutes: 60, scope: { kind: 'dates', dates: ['2026-11-10', '2026-11-12'] } };
test('arbitrary nonconsecutive dates remain separate and invalid date, privilege and TTL inputs fail', () => {
  assert.equal(normalizeGrant(selected, now).windows.length, 2);
  assert.throws(() => normalizeGrant({ ...selected, permissions: ['read', 'admin'] }, now));
  assert.throws(() => normalizeGrant({ ...selected, minutes: -1 }, now));
  assert.throws(() => normalizeGrant({ ...selected, scope: { kind: 'dates', dates: ['2026-02-30'] } }, now));
  assert.equal(normalizeGrant({ ...selected, scope: { kind: 'recent', days: 7 } }, now).windows[0].to, now);
});
test('lock policy, exact expiry, read-only permission and boot revocation are enforced for every call', () => {
  let current = now;
  const registry = new GrantRegistry({ now: () => current });
  const ordinary = registry.issue(selected), continued = registry.issue({ ...selected, continueWhenLocked: true });
  assert.throws(() => registry.authenticate(continued.token, { operation: 'delete' }), /grant_forbidden/);
  assert.throws(() => registry.authenticate(continued.token, { lane: 'windows' }), /grant_forbidden/);
  registry.lock();
  assert.throws(() => registry.authenticate(ordinary.token), /grant_expired/);
  assert.equal(registry.authenticate(continued.token, { locked: true }).name, selected.name);
  current = now + 60 * 60000;
  assert.throws(() => registry.authenticate(continued.token, { locked: true }), /grant_expired/);
  assert.equal(registry.needsKeysWhileLocked(), false);
  current = now;
  const rebooted = registry.issue({ ...selected, continueWhenLocked: true }); registry.reset();
  assert.throws(() => registry.authenticate(rebooted.token), /grant_expired/);
});
test('a broad SQL query cannot reveal the unapproved day between two permitted days', () => {
  const connection = new DatabaseSync(':memory:');
  connection.exec(`CREATE TABLE samples(at INTEGER,codex_up INTEGER,codex_down INTEGER,all_up INTEGER,all_down INTEGER);
    CREATE TABLE buckets(minute INTEGER,connection_id TEXT,scope TEXT,up INTEGER,down INTEGER,last_at INTEGER);
    CREATE TABLE connections(id TEXT,host TEXT,network TEXT,process TEXT,pid INTEGER,scope TEXT,evidence TEXT,first_seen INTEGER,last_seen INTEGER,rule TEXT);
    CREATE TABLE connection_families(connection_id TEXT,family TEXT,root_process TEXT,updated_at INTEGER);
    CREATE TABLE collection_gaps(id INTEGER,reason TEXT,started_at INTEGER,ended_at INTEGER);
    CREATE TABLE alerts(id INTEGER,at INTEGER,message TEXT);CREATE TABLE anomalies(kind TEXT,started_at INTEGER,ended_at INTEGER,detail TEXT);
    CREATE TABLE sessions(id TEXT,activity INTEGER);CREATE TABLE daily_usage(day TEXT);`);
  for (const day of [10, 11, 12]) {
    const timestamp = Date.parse(`2026-11-${day}T12:00:00+08:00`);
    connection.prepare('INSERT INTO samples VALUES (?,?,?,?,?)').run(timestamp, day, 0, day, 0);
    connection.prepare('INSERT INTO buckets VALUES (?,?,?,?,?,?)').run(timestamp, `connection-${day}`, 'other', day, 0, timestamp);
    connection.prepare('INSERT INTO connections VALUES (?,?,?,?,?,?,?,?,?,?)').run(`connection-${day}`, `day-${day}.example.test`, 'tcp', 'synthetic.exe', 1, 'other', 'test', timestamp, timestamp, 'proxy');
  }
  restrictReadConnection(connection, normalizeGrant(selected, now).windows);
  assert.equal(connection.prepare('SELECT SUM(all_up) AS total FROM samples').get().total, 22);
  assert.deepEqual(connection.prepare('SELECT host FROM connections ORDER BY host').all().map(row => row.host), ['day-10.example.test', 'day-12.example.test']);
  assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM daily_usage').get().count, 2);
  connection.close();
});

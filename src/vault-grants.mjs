import crypto from 'node:crypto';
import { randomToken, tokenDigest } from './vault-crypto.mjs';
import { archiveSource } from './history-archive.mjs';

const MINUTE = 60000, DAY = 86400000;
export const GRANT_PERMISSIONS = Object.freeze(['read', 'create', 'update', 'delete', 'export', 'rules', 'deleteHistory']);
const dateKey = timestamp => new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10);

export function normalizeWindows(windows, now = Date.now()) {
  if (!Array.isArray(windows) || !windows.length || windows.length > 128) throw new Error('invalid_authorized_dates');
  const sorted = windows.map(window => {
    const from = Number(window.from), to = Number(window.to);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || from % MINUTE || to % MINUTE || to > now + 366 * DAY) throw new Error('invalid_authorized_dates');
    return { from, to };
  }).sort((left, right) => left.from - right.from);
  const result = [];
  for (const window of sorted) {
    const last = result.at(-1);
    if (last && window.from <= last.to) last.to = Math.max(last.to, window.to);
    else result.push({ ...window });
  }
  return result;
}

export function resolveGrantDates(scope = {}, now = Date.now()) {
  const minuteEnd = Math.ceil(now / MINUTE) * MINUTE;
  if (scope.kind === 'all') return [{ from: 0, to: minuteEnd }];
  if (scope.kind === 'recent') {
    const days = Number(scope.days);
    if (![1, 7, 30].includes(days)) throw new Error('invalid_authorized_dates');
    return [{ from: Math.max(0, minuteEnd - days * DAY), to: minuteEnd }];
  }
  if (scope.kind === 'dates') {
    if (!Array.isArray(scope.dates) || !scope.dates.length || scope.dates.length > 128) throw new Error('invalid_authorized_dates');
    return normalizeWindows(scope.dates.map(date => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid_authorized_dates');
      const from = Date.parse(date + 'T00:00:00+08:00');
      if (!Number.isFinite(from) || dateKey(from) !== date) throw new Error('invalid_authorized_dates');
      return { from, to: from + DAY };
    }), now);
  }
  if (scope.kind === 'windows') return normalizeWindows(scope.windows, now);
  throw new Error('invalid_authorized_dates');
}

export function normalizeGrant(input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw new Error('invalid_grant');
  const lanes = [...new Set(input.lanes || [])];
  if (!lanes.length || lanes.some(lane => !['windows', 'clash', 'diagnostics'].includes(lane))) throw new Error('invalid_authorized_sources');
  const permissions = [...new Set(input.permissions || [])];
  if (!permissions.length || permissions.some(permission => !GRANT_PERMISSIONS.includes(permission))) throw new Error('invalid_authorized_permissions');
  const minutes = Number(input.minutes);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('invalid_grant_duration');
  const notBefore = input.notBefore === undefined ? now : Number(input.notBefore);
  if (!Number.isSafeInteger(notBefore) || notBefore < now - MINUTE || notBefore > now + 7 * DAY) throw new Error('invalid_grant_start');
  return {
    name: String(input.name || 'AI 排查').trim().slice(0, 80) || 'AI 排查',
    lanes, permissions, windows: resolveGrantDates(input.scope, now), scope: structuredClone(input.scope),
    issuedAt: now, notBefore, expiresAt: notBefore + minutes * MINUTE,
    continueWhenLocked: input.continueWhenLocked === true,
    linked: input.linked === true,
  };
}

export function intersectWindows(windows, from, to) {
  return windows.map(window => ({ from: Math.max(window.from, from), to: Math.min(window.to, to) })).filter(window => window.to > window.from);
}
export function containsTime(windows, timestamp) { return windows.some(window => timestamp >= window.from && timestamp < window.to); }
export function containsInterval(windows, from, to) { return windows.some(window => from >= window.from && to <= window.to && to > from); }

export class GrantRegistry {
  constructor({ now = Date.now } = {}) {
    this.now = now; this.grants = new Map(); this.byToken = new Map(); this.epoch = crypto.randomUUID();
  }
  issue(input) {
    for (const [id, grant] of this.grants) if (grant.revokedAt !== null || this.now() >= grant.expiresAt) {
      this.grants.delete(id);
      for (const [digest, mapped] of this.byToken) if (mapped === id) this.byToken.delete(digest);
    }
    if (this.grants.size >= 128) throw new Error('too_many_grants');
    const grant = { ...normalizeGrant(input, this.now()), id: crypto.randomUUID(), revokedAt: null, epoch: this.epoch };
    const token = randomToken(), digest = tokenDigest(token);
    this.grants.set(grant.id, grant); this.byToken.set(digest, grant.id);
    return { grant: this.publicGrant(grant), token };
  }
  publicGrant(grant) {
    const { epoch, ...safe } = grant;
    return { ...safe, active: grant.revokedAt === null && this.now() >= grant.notBefore && this.now() < grant.expiresAt };
  }
  list() { return [...this.grants.values()].map(grant => this.publicGrant(grant)); }
  authenticate(token, { locked = false, operation = 'read', lane, from, to } = {}) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 128) throw new Error('unauthorized');
    const grant = this.grants.get(this.byToken.get(tokenDigest(token)));
    if (!grant || grant.epoch !== this.epoch || grant.revokedAt !== null || this.now() < grant.notBefore || this.now() >= grant.expiresAt) throw new Error('grant_expired');
    if (locked && !grant.continueWhenLocked) throw new Error('vault_locked');
    if (!grant.permissions.includes(operation) || lane && !grant.lanes.includes(lane)) throw new Error('grant_forbidden');
    if (from !== undefined && to !== undefined && !intersectWindows(grant.windows, from, to).length) throw new Error('grant_date_forbidden');
    return grant;
  }
  revoke(id) {
    const grant = this.grants.get(id);
    if (!grant) throw new Error('grant_not_found');
    grant.revokedAt = this.now();
    return this.publicGrant(grant);
  }
  lock({ force = false } = {}) {
    for (const grant of this.grants.values()) if (grant.revokedAt === null && (force || !grant.continueWhenLocked)) grant.revokedAt = this.now();
  }
  needsKeysWhileLocked() { return [...this.grants.values()].some(grant => grant.revokedAt === null && grant.continueWhenLocked && this.now() < grant.expiresAt); }
  reset() { this.lock({ force: true }); this.byToken.clear(); this.epoch = crypto.randomUUID(); }
}

export function restrictReadConnection(connection, windows) {
  windows = normalizeWindows(windows);
  const clauses = column => windows.map(window => `(${column}>=${window.from} AND ${column}<${window.to})`).join(' OR ');
  const bounds = windows.map(window => `SELECT ${window.from} AS start,${window.to} AS finish`).join(' UNION ALL ');
  connection.exec(`
    CREATE TEMP VIEW samples AS SELECT * FROM ${archiveSource(connection,'samples')} WHERE ${clauses('at')};
    CREATE TEMP VIEW buckets AS SELECT * FROM ${archiveSource(connection,'buckets')} WHERE ${clauses('minute')};
    CREATE TEMP VIEW connections AS SELECT original.id,original.host,original.network,original.process,original.pid,original.scope,original.evidence,
      (SELECT MIN(minute) FROM temp.buckets WHERE connection_id=original.id) AS first_seen,
      (SELECT MAX(last_at) FROM temp.buckets WHERE connection_id=original.id) AS last_seen,original.rule
      FROM main.connections original WHERE EXISTS(SELECT 1 FROM temp.buckets WHERE connection_id=original.id);
    CREATE TEMP VIEW connection_families AS SELECT family.* FROM main.connection_families family JOIN temp.connections connection ON family.connection_id=connection.id;
    CREATE TEMP VIEW collection_gaps AS SELECT gap.id,gap.reason,MAX(gap.started_at,period.start) AS started_at,
      MIN(COALESCE(gap.ended_at,period.finish),period.finish) AS ended_at
      FROM main.collection_gaps gap JOIN (${bounds}) period ON gap.started_at<period.finish AND COALESCE(gap.ended_at,period.finish)>period.start;
    CREATE TEMP VIEW alerts AS SELECT * FROM main.alerts WHERE ${clauses('at')};
    CREATE TEMP VIEW anomalies AS SELECT * FROM main.anomalies WHERE ${windows.map(window => `(started_at>=${window.from} AND ended_at<${window.to})`).join(' OR ')};
    CREATE TEMP VIEW sessions AS SELECT * FROM main.sessions WHERE ${clauses('activity')};
    CREATE TEMP VIEW daily_usage AS SELECT date(at/1000,'unixepoch','+8 hours') AS day,SUM(codex_up) AS codex_up,SUM(codex_down) AS codex_down,
      SUM(all_up) AS all_up,SUM(all_down) AS all_down,MIN(at) AS first_at,MAX(at) AS last_at FROM temp.samples GROUP BY day;
  `);
}

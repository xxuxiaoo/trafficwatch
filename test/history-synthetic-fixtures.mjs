import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.mjs';

export const MINUTE = 60_000;
export const BASE = Date.parse('2026-11-11T02:00:00Z');
const outputRoot = os.tmpdir();

export function fixture(t) {
  fs.mkdirSync(outputRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(outputRoot, 'history-api-synthetic-'));
  const stores = new Set();
  t.after(() => {
    for (const store of stores) store.close();
    if (path.dirname(root) !== path.resolve(outputRoot)) throw new Error('Unexpected test fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    open(lane) {
      const store = new Store(path.join(root, lane));
      stores.add(store);
      return store;
    },
    close(store) {
      store.close();
      stores.delete(store);
    },
  };
}

export function rule(chains = ['Synthetic proxy'], extra = {}) {
  return JSON.stringify({
    source: 'mihomo', type: 'MATCH', chains,
    localIP: '127.0.0.1', localPort: 50_001,
    destinationIP: '192.0.2.10', destinationPort: 443,
    ...extra,
  });
}

export function connection(key, up, down, extra = {}) {
  return {
    key, up, down, host: `${key}.example.test`, network: 'tcp',
    process: 'browser.exe', pid: 101, scope: 'other', evidence: 'process',
    family: 'other', familyRoot: '', rule: 'legacy-rule',
    ...extra,
  };
}

export function bytes(rows) {
  return rows.reduce((sum, row) => ({ up: sum.up + row.up, down: sum.down + row.down }), { up: 0, down: 0 });
}

export function assertBytes(actual, up, down, message) {
  assert.ok(actual, message || 'expected byte totals');
  assert.deepEqual({ up: actual.up, down: actual.down }, { up, down }, message);
}

export function record(store, at, rows, extra = {}) {
  const codex = bytes(rows.filter((row) => row.scope === 'codex'));
  const unknown = bytes(rows.filter((row) => row.scope === 'unknown'));
  const all = bytes(rows);
  const sample = {
    at, duration: 1000, rows, activeSessions: [],
    codexUp: codex.up, codexDown: codex.down,
    unknownUp: unknown.up, unknownDown: unknown.down,
    allUp: all.up, allDown: all.down,
    ...extra,
  };
  assert.equal(store.record(sample), true, 'synthetic sample must be recorded once');
  return sample;
}

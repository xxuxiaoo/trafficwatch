import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CODEX_PROCESS_NAMES, normalizeHarnessApps } from '../src/harness.mjs';
import { classifyProcess, ProcessObserver } from '../src/processes.mjs';

const NOW = Date.parse('2026-11-11T02:00:00Z');
const config = (extra = {}) => ({
  processNames: [...DEFAULT_CODEX_PROCESS_NAMES], includeDescendants: true,
  harnessApps: { claude: ['claude.exe'], dsh: ['dsh.exe'] },
  ...extra,
});
const processes = (...rows) => new Map(rows.map((row) => [row.pid, row]));
const proc = (pid, name, extra = {}) => ({ pid, name, ppid: 0, born: NOW - 10_000, ...extra });

function observer(t, rows, options) {
  const result = new ProcessObserver(config(options));
  result.at = NOW;
  result.processes = processes(...rows);
  t.after(() => result.stop());
  return result;
}

test('verified Node entry-script hints classify all Harness families and retain their roots', () => {
  for (const family of ['dsh', 'claude', 'codex']) {
    const result = classifyProcess(10, processes(proc(10, 'node.exe', { familyHint: family })), config());
    assert.equal(result.family, family);
    assert.equal(result.familyRoot, `script:${family}`);
    assert.equal(result.scope, family === 'codex' ? 'codex' : 'other');
    assert.equal(result.evidence, 'process');
    assert.equal(result.process, 'node.exe');
    assert.equal(result.pid, 10);
  }
});

test('unhinted Node processes and lookalike names never get a broad DSH family', () => {
  for (const [name, extra] of [
    ['node.exe', {}],
    ['node', { path: 'C:\\tools\\dsh\\node' }],
    ['node.exe', { familyHint: 'not-a-harness' }],
    ['my-dsh.exe', {}],
    ['dsh.exe.backup', {}],
  ]) {
    const result = classifyProcess(10, processes(proc(10, name, extra)), config());
    assert.equal(result.family, 'other', name);
    assert.equal(result.scope, 'other', name);
  }
  assert.equal(classifyProcess(999, new Map(), config()), null);
});

test('DSH script ancestry attributes the child identity and obeys includeDescendants', () => {
  const tree = processes(
    proc(10, 'node.exe', { familyHint: 'dsh', born: NOW - 20_000 }),
    proc(11, 'cmd.exe', { ppid: 10, born: NOW - 15_000 }),
    proc(12, 'worker.exe', { ppid: 11 }),
  );
  const child = classifyProcess(12, tree, config());
  assert.deepEqual(child, { scope: 'other', family: 'dsh', familyRoot: 'script:dsh', evidence: 'descendant', process: 'worker.exe', pid: 12 });
  assert.equal(classifyProcess(12, tree, config({ includeDescendants: false })).family, 'other');
  const named = classifyProcess(12, processes(
    proc(10, 'DSH.EXE', { born: NOW - 20_000 }), proc(12, 'worker.exe', { ppid: 10 }),
  ), config());
  assert.equal(named.familyRoot, 'dsh.exe');
  assert.equal(named.evidence, 'descendant');
});

test('reused parent PIDs and cyclic process trees cannot invent DSH ancestry', () => {
  const reused = processes(
    proc(10, 'node.exe', { familyHint: 'dsh', born: NOW - 1000 }),
    proc(12, 'worker.exe', { ppid: 10, born: NOW - 10_000 }),
  );
  assert.equal(classifyProcess(12, reused, config()).family, 'other');
  const cyclic = processes(proc(10, 'node.exe', { ppid: 12 }), proc(12, 'worker.exe', { ppid: 10 }));
  assert.equal(classifyProcess(12, cyclic, config()).family, 'other');
});

test('shared runtimes cannot be configured as global Claude or DSH aliases', () => {
  for (const family of ['dsh', 'claude']) {
    for (const name of ['node.exe', 'NODE', 'C:\\runtime\\node.exe', 'python.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe']) {
      assert.throws(() => normalizeHarnessApps({ [family]: [name] }), /Shared runtimes/, `${family}: ${name}`);
    }
  }
});

test('ProcessObserver socket lookup recognizes a verified DSH Node script without spawning an observer', (t) => {
  const observed = observer(t, [proc(10, 'node.exe', { familyHint: 'dsh' })]);
  observed.sockets.set('tcp:50001', [{ ip: '127.0.0.1', port: 50001, pid: 10 }]);
  const metadata = { process: 'node.exe', network: 'TCP', sourcePort: 50001, sourceIP: '::ffff:127.0.0.1' };
  const identified = observed.classify(metadata, NOW + 1000);
  assert.equal(identified.family, 'dsh');
  assert.equal(identified.familyRoot, 'script:dsh');
  assert.equal(identified.pid, 10);
  assert.equal(identified.evidence, 'process');
  observed.processes.set(10, proc(10, 'node.exe'));
  assert.equal(observed.classify(metadata, NOW + 1000).family, 'other');
});

test('ProcessObserver ignores ambiguous sockets and conflicting names after source-port reuse', (t) => {
  const observed = observer(t, [proc(10, 'node.exe', { familyHint: 'dsh' }), proc(20, 'browser.exe')]);
  const metadata = { process: 'browser.exe', network: 'tcp', sourcePort: 50001, sourceIP: '127.0.0.1', host: 'dsh.example.test' };
  observed.sockets.set('tcp:50001', [{ ip: '127.0.0.1', pid: 10 }]);
  const conflict = observed.classify(metadata, NOW);
  assert.equal(conflict.family, 'other');
  assert.equal(conflict.process, 'browser.exe');
  assert.equal(conflict.pid, null);
  observed.sockets.set('tcp:50001', [{ ip: '127.0.0.1', pid: 10 }, { ip: '127.0.0.1', pid: 20 }]);
  assert.equal(observed.classify({ ...metadata, process: 'node.exe' }, NOW).family, 'other');
  assert.equal(observed.classify({ ...metadata, process: '' }, NOW), null);
});

test('ProcessObserver does not trust stale or future socket snapshots for a generic Node process', (t) => {
  const observed = observer(t, [proc(10, 'node.exe', { familyHint: 'dsh' })]);
  observed.sockets.set('tcp:50001', [{ ip: '127.0.0.1', pid: 10 }]);
  const metadata = { process: 'node.exe', network: 'tcp', sourcePort: 50001, sourceIP: '127.0.0.1' };
  for (const at of [NOW - 1, NOW + 6001]) assert.equal(observed.classify(metadata, at).family, 'other');
});

test('native PID and birth verification preserves DSH script and descendant evidence without sockets', (t) => {
  const observed = observer(t, [
    proc(10, 'node.exe', { familyHint: 'dsh', born: NOW - 20_000 }),
    proc(12, 'worker.exe', { ppid: 10, born: NOW - 10_000 }),
  ]);
  const direct = observed.classify({ native: true, processId: 10, process: 'node.exe', processBorn: NOW - 20_000 }, NOW);
  assert.equal(direct.family, 'dsh');
  assert.equal(direct.familyRoot, 'script:dsh');
  assert.equal(direct.evidence, 'etw');
  const child = observed.classify({ native: true, processId: 12, process: 'worker.exe', processBorn: NOW - 10_000 }, NOW);
  assert.equal(child.family, 'dsh');
  assert.equal(child.familyRoot, 'script:dsh');
  assert.equal(child.evidence, 'etw_descendant');
  assert.equal(child.process, 'worker.exe');
  assert.equal(child.pid, 12);
});

test('native PID reuse cannot borrow a cached Node script hint or DSH parent', (t) => {
  const observed = observer(t, [
    proc(10, 'node.exe', { familyHint: 'dsh', born: NOW - 1000 }),
    proc(12, 'worker.exe', { ppid: 10, born: NOW - 500 }),
  ]);
  for (const [processId, processName] of [[10, 'node.exe'], [12, 'worker.exe']]) {
    const result = observed.classify({ native: true, processId, process: processName, processBorn: NOW - 30_000 }, NOW);
    assert.equal(result.family, 'other');
    assert.equal(result.process, processName);
    assert.equal(result.pid, processId);
    assert.equal(result.evidence, 'etw');
  }
  const missingBirth = observed.classify({ native: true, processId: 10, process: 'node.exe', processBorn: 0 }, NOW);
  assert.equal(missingBirth.family, 'other');
  const unnamed = observed.classify({ native: true, processId: 10, processBorn: NOW - 30_000 }, NOW);
  assert.equal(unnamed.scope, 'unknown');
  assert.equal(unnamed.pid, null);
});

test('ProcessObserver alias changes remove stale direct classification and preserve verified scripts', (t) => {
  const observed = observer(t, [proc(10, 'retired-dsh.exe'), proc(20, 'node.exe', { familyHint: 'dsh' })], {
    harnessApps: { claude: ['claude.exe'], dsh: ['dsh.exe', 'retired-dsh.exe'] },
  });
  const direct = { process: 'retired-dsh.exe' };
  assert.equal(observed.classify(direct, NOW).family, 'dsh');
  observed.setHarnessApps({ claude: ['claude.exe'], dsh: ['dsh.exe'] });
  assert.equal(observed.classify(direct, NOW).family, 'other');
  const script = observed.classify({ native: true, processId: 20, process: 'node.exe', processBorn: NOW - 10_000 }, NOW);
  assert.equal(script.family, 'dsh');
  assert.equal(script.familyRoot, 'script:dsh');
  observed.setHarnessApps({ claude: ['claude.exe', 'retired-dsh.exe'], dsh: ['dsh.exe'] });
  assert.equal(observed.classify(direct, NOW).family, 'claude');
});

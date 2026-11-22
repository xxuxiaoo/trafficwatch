import assert from 'node:assert/strict';
import { Accounting } from '../src/accounting.mjs';
import { DEFAULT_CODEX_PROCESS_NAMES } from '../src/harness.mjs';
import { ProcessObserver } from '../src/processes.mjs';

export const bundlePath = 'C:\\SyntheticApps\\Antigravity\\resources\\bin\\language_server.exe';
export const config = (extra = {}) => ({
  processNames: DEFAULT_CODEX_PROCESS_NAMES, includeDescendants: true, harnessApps: {}, ...extra,
});

export function antigravityObserver(at) {
  const observer = new ProcessObserver(config());
  observer.at = at;
  const rows = [
    { pid: 10, name: 'Antigravity.exe', ppid: 0, born: at - 90000 },
    { pid: 11, name: 'language_server.exe', path: bundlePath, ppid: 10, born: at - 80000 },
    { pid: 12, name: 'node.exe', ppid: 11, born: at - 70000 },
    { pid: 13, name: 'codex.exe', ppid: 12, born: at - 60000 },
    { pid: 14, name: 'language_server.exe', path: 'C:\\SyntheticApps\\OtherEditor\\resources\\bin\\language_server.exe', ppid: 0, born: at - 80000 },
  ];
  observer.processes = new Map(rows.map(row => [row.pid, row]));
  return observer;
}

export const nativeIdentity = (observer, pid) => {
  const process = observer.processes.get(pid);
  return { native: true, processId: pid, process: process.name, processBorn: process.born };
};

export function recordAntigravity(windows, clash, at) {
  const observer = antigravityObserver(at);
  const classify = (metadata, time) => observer.classify(metadata, time);
  const connection = (id, upload, download, metadata, chains = []) => ({
    id, upload, download, chains, rule: 'MATCH', start: new Date(at + 1).toISOString(),
    metadata: { network: 'tcp', host: 'agent.example.test', destinationIP: '192.0.2.80', destinationPort: 443, ...metadata },
  });
  const local = new Accounting({ preserveRouteMetadata: true });
  const localRows = [
    connection('main', 2000, 3000, { ...nativeIdentity(observer, 10), host: 'client.example.test' }),
    connection('bundle', 4000, 6000, nativeIdentity(observer, 11)),
    connection('child', 1000, 2000, { ...nativeIdentity(observer, 12), host: 'tool.example.test' }),
    connection('nested-codex', 6000, 4000, nativeIdentity(observer, 13)),
    connection('unrelated-language-server', 8000, 9000, nativeIdentity(observer, 14)),
  ];
  assert.equal(windows.record(local.consume({ incremental: true, uploadTotal: 21000, downloadTotal: 24000, connections: localRows }, at + 1000, classify)), true);

  const proxy = new Accounting({ preserveRouteMetadata: true });
  proxy.consume({ proxyClient: 'verge', uploadTotal: 0, downloadTotal: 0, connections: [] }, at, classify);
  const bundled = { process: 'language_server.exe', processPath: bundlePath };
  const proxyRows = [
    connection('proxy-bundle', 3000, 6000, bundled, ['Example node']),
    connection('direct-bundle', 1000, 2000, { ...bundled, host: 'direct.example.test' }, ['DIRECT']),
    connection('same-host-browser', 1000, 2000, { process: 'msedge.exe' }, ['Example node']),
  ];
  assert.equal(clash.record(proxy.consume({ proxyClient: 'verge', uploadTotal: 5000, downloadTotal: 10000, connections: proxyRows }, at + 1000, classify)), true);
}

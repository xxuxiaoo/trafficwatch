import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  ANTIGRAVITY_BUNDLE_ROOT, SCRIPT_HARNESS_FAMILIES, familyForProcess, isAntigravityBundleImage,
  isHarnessFamily, normalizeHarnessApps, processFamilyMap, processImageName,
} from './harness.mjs';

const normalizedName = value => processImageName(value).toLowerCase();

function imageFamily(name, executable, families) {
  const root = normalizedName(name || executable);
  const named = familyForProcess(root, families);
  if (!isHarnessFamily(named) && isAntigravityBundleImage(name, executable)) {
    return { family: 'antigravity', familyRoot: ANTIGRAVITY_BUNDLE_ROOT };
  }
  return { family: named, familyRoot: root };
}
export function classifyProcess(
  pid,
  processes,
  config,
  families = processFamilyMap(normalizeHarnessApps(config.harnessApps, config.processNames || [])),
) {
  let p = processes.get(Number(pid));
  const origin = p;
  const visited = new Set();
  let verifiedAncestry = true;
  while (p && !visited.has(p.pid)) {
    visited.add(p.pid);
    const identity = SCRIPT_HARNESS_FAMILIES.includes(p.familyHint)
      ? { family: p.familyHint, familyRoot: `script:${p.familyHint}` }
      : imageFamily(p.name, p.path, families);
    if (isHarnessFamily(identity.family)) {
      if (identity.family === 'antigravity' && p !== origin && !verifiedAncestry) break;
      return {
        scope: identity.family === 'codex' ? 'codex' : 'other',
        ...identity,
        evidence: p === origin ? 'process' : 'descendant',
        process: processImageName(origin.name || origin.path),
        pid: origin.pid,
      };
    }
    if (!config.includeDescendants) break;
    const parent = processes.get(p.ppid);
    // Prevent PID reuse from creating a false ancestry edge.
    if (parent?.born && p.born && parent.born > p.born) break;
    if (!(p.born > 0 && parent?.born > 0)) verifiedAncestry = false;
    p = parent;
  }
  return origin
    ? { scope: 'other', family: 'other', evidence: 'process', process: processImageName(origin.name || origin.path), pid: origin.pid }
    : null;
}

export class ProcessObserver {
  constructor(config) {
    this.config = config;
    this.families = processFamilyMap(normalizeHarnessApps(config.harnessApps, config.processNames || []));
    this.at = 0;
    this.processes = new Map();
    this.sockets = new Map();
    this.status = 'starting';
    this.stopping = false;
  }
  setHarnessApps(apps) {
    this.config.harnessApps = apps;
    this.families = processFamilyMap(normalizeHarnessApps(apps, this.config.processNames || []));
  }
  start() {
    if (this.stopping) return;
    if (process.platform !== 'win32') {
      this.status = 'unsupported';
      return;
    }
    this.child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(this.config.root, 'scripts', 'windows-observer.ps1'),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      try {
        const packet = JSON.parse(line.replace(/^\uFEFF/, ''));
        if (packet.error) {
          this.status = 'error';
          return;
        }
        this.processes = new Map(packet.processes.map((p) => [p.pid, p]));
        this.sockets = new Map();
        for (const s of packet.sockets) {
          const key = `${s.network}:${s.port}`;
          const rows = this.sockets.get(key) || [];
          rows.push(s);
          this.sockets.set(key, rows);
        }
        this.at = packet.at;
        this.status = 'ready';
      } catch {
        this.status = 'error';
      }
    });
    this.child.stderr.on('data', () => {
      this.status = 'error';
    });
    this.child.on('error', () => {
      this.status = 'error';
      this.scheduleRestart();
    });
    this.child.on('exit', () => {
      this.status = 'stopped';
      this.scheduleRestart();
    });
  }
  scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, 10000);
  }
  classify(metadata, now = Date.now()) {
    if (metadata.native) {
      const pid = Number(metadata.processId), owner = this.processes.get(pid);
      const name = processImageName(metadata.process);
      // ETW supplies a PID even for a connection that closes between socket polls.
      // Verify process creation time before using cached ancestry after PID reuse.
      let p = owner;
      const visited = new Set();
      while (p && !visited.has(p.pid)) {
        visited.add(p.pid);
        if (this.config.excludePids?.includes(p.pid)) return { scope: 'other', family: 'other', evidence: 'etw', process: name, pid };
        p = this.processes.get(p.ppid);
      }
      if (this.config.excludePids?.includes(pid)) return { scope: 'other', family: 'other', evidence: 'etw', process: name, pid };
      const age = now - this.at;
      if (owner && age >= 0 && age <= 6000 && metadata.processBorn > 0 && Math.abs(owner.born - metadata.processBorn) < 2) {
        const result = classifyProcess(pid, this.processes, this.config, this.families);
        if (result) return { ...result, evidence: result.evidence === 'descendant' ? 'etw_descendant' : 'etw' };
      }
      const family = familyForProcess(name, this.families);
      return name ? { scope: family === 'codex' ? 'codex' : 'other', family, familyRoot: normalizedName(name), evidence: 'etw', process: name, pid }
        : { scope: 'unknown', family: 'unknown', evidence: 'none', process: '', pid: null };
    }
    // Prefer kernel connection metadata when present. An unrecognised named process
    // must remain "other", even if its hostname happens to be chatgpt.com.
    let named = null;
    if (metadata.process || metadata.processPath) {
      const name = metadata.process ? processImageName(metadata.process) : normalizedName(metadata.processPath);
      const identity = imageFamily(name, metadata.processPath || metadata.process, this.families);
      named = { scope: identity.family === 'codex' ? 'codex' : 'other', ...identity, evidence: 'mihomo', process: name, pid: null };
      if (isHarnessFamily(identity.family)) return named;
    }
    const age = now - this.at;
    if (!this.at || age < 0 || age > 6000) return named;
    const rows =
      this.sockets.get(`${String(metadata.network).toLowerCase()}:${metadata.sourcePort}`) || [];
    const clean = (x) => String(x).replace(/^::ffff:/, '');
    const exact = rows.filter((x) => clean(x.ip) === clean(metadata.sourceIP));
    const wildcard = rows.filter((x) => x.ip === '0.0.0.0' || x.ip === '::');
    const candidates = exact.length ? exact : wildcard;
    const pids = [...new Set(candidates.map((x) => x.pid))];
    if (pids.length !== 1) return named;
    const owner = this.processes.get(pids[0]);
    // Conflicting names can indicate source-port/PID reuse. Keep the controller's
    // identity instead of assigning another process's ancestry to this connection.
    if (named && normalizedName(named.process) !== normalizedName(owner?.name)) return named;
    return classifyProcess(pids[0], this.processes, this.config, this.families) || named;
  }
  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.lines?.close();
    this.child?.kill();
  }
}

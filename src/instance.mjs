import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const START_TOLERANCE_MS = 15000;
const LEGACY_MTIME_TOLERANCE_MS = 60000;

const defaultCheckPid = (pid) => process.kill(pid, 0);

function currentScriptPath() {
  return process.argv[1] ? path.resolve(process.argv[1]) : null;
}

function defaultInspectPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === 'win32') {
    const command = [
      "$ErrorActionPreference='Stop'",
      'try {',
      `  $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'`,
      '  if (-not $p) { \'{"alive":false}\'; exit 0 }',
      '  $s = $null',
      '  if ($p.CreationDate) { $s = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }',
      '  @{ alive = $true; startedAt = $s; commandLine = $p.CommandLine; executablePath = $p.ExecutablePath } | ConvertTo-Json -Compress',
      '} catch { exit 1 }',
    ].join('; ');
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    if (result.error || result.status !== 0) return null;
    try {
      const parsed = JSON.parse((result.stdout || '').trim());
      if (parsed && typeof parsed.alive === 'boolean') return parsed;
    } catch {
      /* Unparseable output must fail closed. */
    }
    return null;
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.statSync(`/proc/${pid}`);
      let commandLine = null;
      try {
        commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim() || null;
      } catch {
        /* Unreadable cmdline keeps commandLine null so caller fails closed unless start time proves reuse. */
      }
      return { alive: true, startedAt: Math.round(stat.ctimeMs), commandLine };
    } catch (error) {
      if (error.code === 'ENOENT') return { alive: false };
      return null;
    }
  }
  return null;
}

function isDemonstrablyReused(owner, lockMtimeMs, live, callerScript) {
  if (!live || typeof live !== 'object') return false;
  if (live.alive === false) return true;
  if (live.alive !== true) return false;
  if (Number.isFinite(live.startedAt)) {
    if (Number.isFinite(owner.pidStartedAt)) {
      if (Math.abs(live.startedAt - owner.pidStartedAt) > START_TOLERANCE_MS) return true;
    } else {
      const lockRef = Number.isFinite(owner.startedAt)
        ? Math.max(owner.startedAt, lockMtimeMs)
        : lockMtimeMs;
      if (Number.isFinite(lockRef) && live.startedAt > lockRef + LEGACY_MTIME_TOLERANCE_MS) {
        return true;
      }
    }
  }
  if (typeof live.commandLine === 'string' && live.commandLine.trim()) {
    const ownerBase = typeof owner.script === 'string' && owner.script.trim()
      ? path.basename(owner.script).toLowerCase()
      : callerScript && path.basename(callerScript).toLowerCase() === 'main.mjs'
        ? 'main.mjs'
        : null;
    if (ownerBase && !live.commandLine.toLowerCase().includes(ownerBase)) return true;
  }
  return false;
}

// One collector per data directory, independently of its HTTP port. An unknown
// lock is never removed automatically; only a demonstrably dead or reused PID is reclaimed.
export function acquireInstance(
  dir,
  checkPid = defaultCheckPid,
  inspectPid = checkPid === defaultCheckPid ? defaultInspectPid : null,
) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'collector.lock');
  const now = Date.now();
  const script = currentScriptPath();
  const identity = JSON.stringify({
    pid: process.pid,
    token: randomUUID(),
    startedAt: now,
    pidStartedAt: Math.round(now - process.uptime() * 1000),
    script,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, identity);
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            if (fs.readFileSync(file, 'utf8') === identity) fs.unlinkSync(file);
          } catch {
            /* Already removed. */
          }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try {
        previous = fs.readFileSync(file, 'utf8');
        const lockMtimeMs = fs.statSync(file).mtimeMs;
        const owner = JSON.parse(previous);
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Unknown owner');
        let reclaimable = false;
        if (owner.pid !== process.pid) {
          try {
            checkPid(owner.pid);
            if (typeof inspectPid === 'function') {
              reclaimable = isDemonstrablyReused(owner, lockMtimeMs, inspectPid(owner.pid), script);
            }
          } catch (failure) {
            if (failure.code !== 'ESRCH') throw failure;
            reclaimable = true;
          }
        }
        if (reclaimable) {
          if (fs.readFileSync(file, 'utf8') === previous) fs.unlinkSync(file);
          continue;
        }
      } catch (failure) {
        if (failure.code === 'ENOENT') continue;
      }
      throw new Error(
        'This data directory already has a collector or an unverifiable collector.lock. Stop its monitor first, or use a separate CODEX_FLOW_DATA_DIR.',
      );
    }
  }
  throw new Error('Could not acquire collector.lock; another monitor may be starting.');
}

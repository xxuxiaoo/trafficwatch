import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const DISCOVERY_UDP_LABELS = new Map([
  [5353, 'lan-mdns:5353'],
  [1900, 'lan-ssdp:1900'],
  [5355, 'lan-llmnr:5355'],
  [137, 'lan-netbios:137'],
  [138, 'lan-netbios:138'],
]);
const KNOWN_LOCAL_SERVICE_PORTS = new Set([43128, 43130, 43131, 43132, 3425, 7890, 7897, 10808, 10809]);

function normalizeIp(ip) {
  const lower = String(ip || '').toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower;
}

function isLoopbackIp(ip) {
  const value = normalizeIp(ip);
  return value === '::1' || value.startsWith('127.');
}

function isLocalOrMulticastIp(ip) {
  const value = normalizeIp(ip);
  if (!value) return false;
  if (isLoopbackIp(value) || value === '255.255.255.255' || value === '0.0.0.0' || value === '::') return true;
  if (value.includes('.')) {
    const parts = value.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a >= 224 && a <= 239) || a === 100 && b >= 64 && b <= 127;
  }
  return value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff');
}

function discoveryCanonicalIp(port, ip) {
  const v6 = String(ip || '').includes(':') && !String(ip || '').toLowerCase().startsWith('::ffff:');
  if (port === 5353) return v6 ? 'ff02::fb' : '224.0.0.251';
  if (port === 1900) return v6 ? 'ff02::c' : '239.255.255.250';
  if (port === 5355) return v6 ? 'ff02::1:3' : '224.0.0.252';
  return v6 ? 'ff02::1' : '255.255.255.255';
}

function aggregateDescriptor(r, generation) {
  const base = `${generation}:${r.processId}:${r.processBorn || 0}`;
  if (r.network === 'udp') {
    const discoveryPort = DISCOVERY_UDP_LABELS.has(r.sourcePort)
      ? r.sourcePort
      : DISCOVERY_UDP_LABELS.has(r.destinationPort)
        ? r.destinationPort
        : 0;
    if (discoveryPort && isLocalOrMulticastIp(r.destinationIP)) {
      return {
        id: `etw:${base}:udp:discovery:${discoveryPort}`,
        host: DISCOVERY_UDP_LABELS.get(discoveryPort),
        sourcePort: discoveryPort,
        destinationIP: discoveryCanonicalIp(discoveryPort, r.destinationIP),
        destinationPort: discoveryPort,
      };
    }
  }
  if (isLoopbackIp(r.sourceIP) && isLoopbackIp(r.destinationIP)) {
    const dstIp = normalizeIp(r.destinationIP);
    const srcIp = normalizeIp(r.sourceIP);
    if (KNOWN_LOCAL_SERVICE_PORTS.has(r.destinationPort)) {
      return {
        id: `etw:${base}:${r.network}:loopback:${dstIp}:${r.destinationPort}`,
        host: dstIp,
        sourcePort: 0,
        destinationIP: dstIp,
        destinationPort: r.destinationPort,
      };
    }
    if (KNOWN_LOCAL_SERVICE_PORTS.has(r.sourcePort)) {
      return {
        id: `etw:${base}:${r.network}:loopback-srv:${srcIp}:${r.sourcePort}`,
        host: dstIp,
        sourcePort: r.sourcePort,
        destinationIP: dstIp,
        destinationPort: 0,
      };
    }
    return {
      id: `etw:${base}:${r.network}:loopback:${dstIp}`,
      host: dstIp,
      sourcePort: 0,
      destinationIP: dstIp,
      destinationPort: 0,
    };
  }
  return null;
}

export function nativeSnapshot(packet) {
  if (!packet || packet.type !== 'snapshot' || !Number.isSafeInteger(packet.sequence) ||
      !Number.isFinite(packet.at) || !Number.isFinite(packet.duration) || packet.duration <= 0 ||
      !Array.isArray(packet.rows) || packet.rows.length > 8192) throw new Error('Invalid native snapshot');
  const ids = new Set();
  const merged = new Map();
  const connections = [];
  for (const r of packet.rows) {
    if (!r || typeof r.id !== 'string' || r.id.length > 400 || !['tcp', 'udp'].includes(r.network) ||
        !net.isIP(r.sourceIP) || !net.isIP(r.destinationIP) ||
        !Number.isSafeInteger(r.processId) || r.processId <= 0 ||
        !Number.isSafeInteger(r.upload) || r.upload < 0 || !Number.isSafeInteger(r.download) || r.download < 0)
      throw new Error('Invalid native connection');
    if (ids.has(r.id)) throw new Error('Duplicate native connection');
    ids.add(r.id);
    const generation = typeof packet.generation === 'string' && packet.generation
      ? packet.generation
      : (r.id.includes(':') ? r.id.split(':')[0] : 'native');
    const aggregate = aggregateDescriptor(r, generation);
    if (aggregate) {
      const existing = merged.get(aggregate.id);
      if (existing) {
        existing.upload += r.upload;
        existing.download += r.download;
        if (r.start && (!existing.start || r.start < existing.start)) existing.start = r.start;
        if (!existing.metadata.process && r.process) existing.metadata.process = String(r.process).slice(0, 260);
        continue;
      }
      const row = {
        id: aggregate.id, start: r.start, upload: r.upload, download: r.download, rule: 'Windows ETW',
        metadata: {
          native: true, processId: r.processId, processBorn: r.processBorn,
          process: String(r.process || '').slice(0, 260), network: r.network,
          host: aggregate.host,
          sourceIP: r.sourceIP, sourcePort: aggregate.sourcePort,
          destinationIP: aggregate.destinationIP, destinationPort: aggregate.destinationPort,
        },
      };
      merged.set(aggregate.id, row);
      connections.push(row);
      continue;
    }
    connections.push({
      id: `etw:${r.id}`, start: r.start, upload: r.upload, download: r.download, rule: 'Windows ETW',
      metadata: { native: true, processId: r.processId, processBorn: r.processBorn,
        process: String(r.process || '').slice(0, 260), network: r.network,
        sourceIP: r.sourceIP, sourcePort: r.sourcePort, destinationIP: r.destinationIP,
        destinationPort: r.destinationPort },
    });
  }
  return { incremental: true, duration: packet.duration, eventsLost: packet.eventsLost || 0,
    uploadTotal: connections.reduce((n, r) => n + r.upload, 0),
    downloadTotal: connections.reduce((n, r) => n + r.download, 0), connections };
}

export class NativeSource {
  constructor(config) {
    this.config = config;
    this.state = process.platform === 'win32' ? 'idle' : 'unsupported';
    this.issue = this.state === 'unsupported' ? 'unsupported' : null;
    this.sequence = 0;
    this.endpoint = 'Windows ETW';
    this.generation = 0;
  }
  async start(elevated = false) {
    if (this.state === 'ready') return;
    if (this.starting) return this.starting;
    if (process.platform !== 'win32') throw new Error('Native capture requires Windows');
    const executable = path.join(this.config.root, 'native', 'Codex-Netwatch-Capture.exe');
    if (!fs.existsSync(executable)) { this.state = 'missing'; this.issue = 'native_missing'; throw new Error('Build the native helper first'); }
    this.state = 'starting'; this.issue = null;
    this.starting = new Promise((resolve, reject) => {
      const name = `codex-netwatch-native-${randomBytes(16).toString('hex')}`;
      const token = randomBytes(32).toString('hex');
      const deadline = setTimeout(() => fail('native_timeout'), elevated ? 60000 : 10000);
      const fail = (issue) => {
        clearTimeout(deadline); this.state = 'error'; this.issue = issue;
        this.disposeTransport(); reject(new Error(issue));
      };
      this.cancelStart = () => fail('native_cancelled');
      this.server = net.createServer((socket) => {
        if (this.socket) { socket.destroy(); return; }
        this.socket = socket;
        this.lines = createInterface({ input: socket, crlfDelay: Infinity });
        this.lines.on('line', (line) => {
          if (line.length > 16 * 1024 * 1024) { socket.destroy(); return; }
          try {
            const packet = JSON.parse(line);
            if (this.state === 'starting') {
              if (packet.token !== token) { socket.destroy(); return; }
              if (packet.type === 'error') { fail(packet.issue === 'elevation_required' ? packet.issue : 'native_failed'); return; }
              if (packet.type !== 'ready' || !/^[a-f0-9]{32}$/.test(packet.generation)) { fail('native_protocol'); return; }
              clearTimeout(deadline); this.generation++; this.sequence = 0;
              this.sessionId = packet.generation;
              this.state = 'ready'; this.issue = null; resolve();
            } else if (packet.type === 'snapshot' && this.pending) {
              if (packet.sequence <= this.sequence) throw new Error('Duplicate native snapshot');
              const snapshot = nativeSnapshot(packet);
              this.sequence = packet.sequence;
              this.pending.resolve(snapshot);
            }
          } catch { this.pending?.reject(new Error('native_protocol')); }
        });
        socket.on('error', () => { this.pending?.reject(new Error('native_disconnected')); });
        socket.on('close', () => {
          if (this.state === 'starting') fail('native_cancelled');
          else if (this.state === 'ready') { this.state = 'error'; this.issue = 'native_disconnected'; this.pending?.reject(new Error(this.issue)); }
        });
      });
      this.server.once('error', () => fail('native_pipe'));
      this.server.listen(`\\\\.\\pipe\\${name}`, () => {
        if (elevated) {
          // Fixed script + environment variables: no user-controlled PowerShell code.
          const script = "$ErrorActionPreference='Stop'; try { Start-Process -FilePath $env:NETWATCH_CAPTURE_EXE -ArgumentList @($env:NETWATCH_CAPTURE_PIPE,$env:NETWATCH_CAPTURE_PARENT,$env:NETWATCH_CAPTURE_TOKEN) -Verb RunAs -WindowStyle Hidden | Out-Null } catch { exit 1 }";
          this.launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true, stdio: 'ignore', env: { ...process.env, NETWATCH_CAPTURE_EXE: executable,
              NETWATCH_CAPTURE_PIPE: name, NETWATCH_CAPTURE_PARENT: String(process.pid), NETWATCH_CAPTURE_TOKEN: token },
          });
          this.launcher.once('exit', (code) => { if (code && this.state === 'starting') fail('native_cancelled'); });
        } else this.launcher = spawn(executable, [name, String(process.pid), token], { windowsHide: true, stdio: 'ignore' });
        this.launcher.once('error', () => fail('native_failed'));
      });
    });
    try { await this.starting; } finally { this.starting = null; this.cancelStart = null; }
  }
  async snapshot() {
    if (this.state !== 'ready') throw new Error(this.issue || 'native_unavailable');
    if (this.pending) throw new Error('Concurrent native poll');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.pending?.reject(new Error('native_timeout')), 5000);
      const settle = (fn, value) => { clearTimeout(timer); this.pending = null; fn(value); };
      this.pending = { resolve: (x) => settle(resolve, x), reject: (x) => settle(reject, x) };
      this.socket.write('snapshot\n');
    }).catch((error) => {
      if (this.state !== 'stopped') { this.state = 'error'; this.issue = 'native_failed'; this.disposeTransport(); }
      throw error;
    });
  }
  disposeTransport() {
    this.pending?.reject(new Error('native_stopped'));
    this.lines?.close(); this.socket?.end('stop\n'); this.socket?.destroy(); this.server?.close();
    this.lines = this.socket = this.server = null;
  }
  stop() { this.cancelStart?.(); this.state = 'stopped'; this.disposeTransport(); }
}

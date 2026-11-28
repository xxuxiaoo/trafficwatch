import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn, spawnSync } from 'node:child_process';
import { NativeSource, nativeSnapshot } from '../src/native.mjs';
import { Accounting } from '../src/accounting.mjs';
import { ProcessObserver } from '../src/processes.mjs';
import { TrafficSource } from '../src/sources.mjs';

const packet = (sequence = 1) => ({ type: 'snapshot', sequence, at: 10000, duration: 1000, eventsLost: 0,
  rows: [{ id: 'unique-lifetime', start: new Date(9000).toISOString(), network: 'tcp', sourceIP: '192.0.2.1',
    destinationIP: '203.0.113.1', sourcePort: 50000, destinationPort: 443, processId: 77, processBorn: 500,
    process: 'codex.exe', upload: 1200, download: 2400 }] });

test('native deltas retain short-lived connections and do not repeat cumulative history', () => {
  const accounting = new Accounting();
  const classify = () => ({ scope: 'codex', process: 'codex.exe', evidence: 'etw', pid: 77 });
  const one = accounting.consume(nativeSnapshot(packet()), 10000, classify);
  assert.equal(one.codexUp, 1200); assert.equal(one.codexDown, 2400); assert.equal(one.allUp, 1200);
  assert.equal(one.duration, 1000);
  const two = accounting.consume(nativeSnapshot({ ...packet(2), rows: [] }), 11000, classify);
  assert.equal(two.codexUp, 0); assert.equal(two.allDown, 0);
  const three = accounting.consume(nativeSnapshot(packet(3)), 12000, classify);
  assert.equal(three.codexUp, 1200); assert.equal(three.codexDown, 2400);
});

test('native adapter rejects malformed counters, destinations and duplicate identity input', () => {
  for (const value of [-1, NaN, Infinity, 1.5]) {
    const p = packet(); p.rows[0].upload = value; assert.throws(() => nativeSnapshot(p));
  }
  const p = packet(); p.rows[0].destinationIP = 'chatgpt.com'; assert.throws(() => nativeSnapshot(p));
  assert.throws(() => nativeSnapshot({ ...packet(), duration: 0 }));
  assert.throws(() => nativeSnapshot({ ...packet(), rows: [...packet().rows, ...packet().rows] }));
});

test('native adapter aggregates LAN discovery UDP and loopback bursts without losing bytes or external tuples', () => {
  const gen = 'a'.repeat(32);
  const start1 = new Date(9000).toISOString();
  const start2 = new Date(9500).toISOString();
  const snap = nativeSnapshot({
    type: 'snapshot', generation: gen, sequence: 1, at: 10000, duration: 1000, eventsLost: 0,
    rows: [
      // Local LAN mDNS discovery from 3 peers -> 1 aggregated row for browser.exe
      { id: `${gen}:10:100:udp:10.0.0.5:5353:10.0.0.21:5353`, start: start2, network: 'udp', sourceIP: '10.0.0.5', sourcePort: 5353, destinationIP: '10.0.0.21', destinationPort: 5353, processId: 10, processBorn: 100, process: 'browser.exe', upload: 0, download: 300 },
      { id: `${gen}:10:100:udp:10.0.0.5:5353:10.0.0.22:5353`, start: start1, network: 'udp', sourceIP: '10.0.0.5', sourcePort: 5353, destinationIP: '10.0.0.22', destinationPort: 5353, processId: 10, processBorn: 100, process: 'browser.exe', upload: 100, download: 400 },
      { id: `${gen}:10:100:udp:10.0.0.5:5353:224.0.0.251:5353`, start: start2, network: 'udp', sourceIP: '10.0.0.5', sourcePort: 5353, destinationIP: '224.0.0.251', destinationPort: 5353, processId: 10, processBorn: 100, process: 'browser.exe', upload: 50, download: 500 },
      // Local LAN SSDP discovery on port 1900 -> 1 aggregated row for svchost.exe
      { id: `${gen}:20:200:udp:10.0.0.5:1900:10.0.0.31:49001`, start: start1, network: 'udp', sourceIP: '10.0.0.5', sourcePort: 1900, destinationIP: '10.0.0.31', destinationPort: 49001, processId: 20, processBorn: 200, process: 'svchost.exe', upload: 0, download: 120 },
      { id: `${gen}:20:200:udp:10.0.0.5:1900:10.0.0.32:49002`, start: start2, network: 'udp', sourceIP: '10.0.0.5', sourcePort: 1900, destinationIP: '10.0.0.32', destinationPort: 49002, processId: 20, processBorn: 200, process: 'svchost.exe', upload: 0, download: 180 },
      // TrafficWatch-Tray polling 127.0.0.1:43128 across ephemeral source ports -> 1 row keeping port 43128
      { id: `${gen}:30:300:tcp:127.0.0.1:51001:127.0.0.1:43128`, start: start1, network: 'tcp', sourceIP: '127.0.0.1', sourcePort: 51001, destinationIP: '127.0.0.1', destinationPort: 43128, processId: 30, processBorn: 300, process: 'TrafficWatch-Tray.exe', upload: 80, download: 220 },
      { id: `${gen}:30:300:tcp:127.0.0.1:51002:127.0.0.1:43128`, start: start2, network: 'tcp', sourceIP: '127.0.0.1', sourcePort: 51002, destinationIP: '127.0.0.1', destinationPort: 43128, processId: 30, processBorn: 300, process: 'TrafficWatch-Tray.exe', upload: 90, download: 210 },
      // Antigravity loopback IPC across dynamic ports -> 1 row preserving pid/born/bytes
      { id: `${gen}:40:400:tcp:127.0.0.1:52001:127.0.0.1:54321`, start: start1, network: 'tcp', sourceIP: '127.0.0.1', sourcePort: 52001, destinationIP: '127.0.0.1', destinationPort: 54321, processId: 40, processBorn: 400, process: 'Antigravity.exe', upload: 500, download: 1500 },
      { id: `${gen}:40:400:tcp:127.0.0.1:52002:127.0.0.1:54322`, start: start2, network: 'tcp', sourceIP: '127.0.0.1', sourcePort: 52002, destinationIP: '127.0.0.1', destinationPort: 54322, processId: 40, processBorn: 400, process: 'Antigravity.exe', upload: 700, download: 2500 },
      // Public UDP on port 5353 MUST NOT be collapsed as LAN discovery; external TCP stays per-socket
      { id: `${gen}:50:500:udp:192.0.2.1:5353:203.0.113.9:5353`, start: start1, network: 'udp', sourceIP: '192.0.2.1', sourcePort: 5353, destinationIP: '203.0.113.9', destinationPort: 5353, processId: 50, processBorn: 500, process: 'app.exe', upload: 11, download: 22 },
      { id: `${gen}:50:500:tcp:192.0.2.1:50001:203.0.113.9:443`, start: start1, network: 'tcp', sourceIP: '192.0.2.1', sourcePort: 50001, destinationIP: '203.0.113.9', destinationPort: 443, processId: 50, processBorn: 500, process: 'app.exe', upload: 33, download: 44 },
      { id: `${gen}:50:500:tcp:192.0.2.1:50002:203.0.113.9:443`, start: start2, network: 'tcp', sourceIP: '192.0.2.1', sourcePort: 50002, destinationIP: '203.0.113.9', destinationPort: 443, processId: 50, processBorn: 500, process: 'app.exe', upload: 55, download: 66 },
    ],
  });
  assert.equal(snap.connections.length, 7);
  assert.equal(snap.uploadTotal, 100 + 50 + 80 + 90 + 500 + 700 + 11 + 33 + 55);
  assert.equal(snap.downloadTotal, 300 + 400 + 500 + 120 + 180 + 220 + 210 + 1500 + 2500 + 22 + 44 + 66);
  const mdns = snap.connections.find((c) => c.id === `etw:${gen}:10:100:udp:discovery:5353`);
  assert.deepEqual([mdns.upload, mdns.download, mdns.start, mdns.metadata.host, mdns.metadata.destinationIP], [150, 1200, start1, 'lan-mdns:5353', '224.0.0.251']);
  const ssdp = snap.connections.find((c) => c.id === `etw:${gen}:20:200:udp:discovery:1900`);
  assert.deepEqual([ssdp.upload, ssdp.download, ssdp.metadata.host, ssdp.metadata.destinationIP], [0, 300, 'lan-ssdp:1900', '239.255.255.250']);
  const tray = snap.connections.find((c) => c.id === `etw:${gen}:30:300:tcp:loopback:127.0.0.1:43128`);
  assert.deepEqual([tray.upload, tray.download, tray.metadata.destinationPort, tray.metadata.sourcePort], [170, 430, 43128, 0]);
  const ag = snap.connections.find((c) => c.id === `etw:${gen}:40:400:tcp:loopback:127.0.0.1`);
  assert.deepEqual([ag.upload, ag.download, ag.metadata.processId, ag.metadata.processBorn], [1200, 4000, 40, 400]);
  assert.equal(snap.connections.filter((c) => c.metadata.processId === 50).length, 3);
});

test('native process evidence validates creation times before using ancestor snapshots', () => {
  const observer = new ProcessObserver({ processNames: ['codex.exe'], includeDescendants: true, excludePids: [88] });
  observer.at = 10000;
  observer.processes = new Map([[1, { pid: 1, name: 'codex.exe', born: 100 }],
    [77, { pid: 77, name: 'node.exe', ppid: 1, born: 500 }],
    [88, { pid: 88, name: 'node.exe', ppid: 1, born: 600 }]]);
  const m = nativeSnapshot(packet()).connections[0].metadata;
  assert.equal(observer.classify({ ...m, process: 'node.exe' }, 10500).scope, 'codex');
  assert.equal(observer.classify({ ...m, process: 'node.exe', processBorn: 700 }, 10500).scope, 'other');
  assert.equal(observer.classify({ ...m, processId: 88, processBorn: 600 }, 10500).scope, 'other');
  assert.equal(observer.classify({ ...m, process: '' }, 20000).scope, 'unknown');
});

test('automatic capture selects one source and never doubles proxy plus native bytes', async () => {
  const source = new TrafficSource({ captureMode: 'auto' });
  source.attempted = true;
  let nativeCalls = 0, proxyCalls = 0;
  source.native = { state: 'ready', generation: 1, snapshot: async () => { nativeCalls++; return nativeSnapshot(packet()); }, stop() {} };
  source.proxy = { generation: 1, snapshot: async () => { proxyCalls++; return { uploadTotal: 999 }; } };
  assert.equal((await source.snapshot()).uploadTotal, 1200);
  assert.equal(nativeCalls, 1); assert.equal(proxyCalls, 0);
  const generation = source.generation;
  await source.setMode('mihomo');
  assert.equal((await source.snapshot()).uploadTotal, 999);
  assert.equal(source.generation, generation + 1); assert.equal(proxyCalls, 1);
  await source.setMode('native');
  const cutover = await source.snapshot();
  assert.equal(cutover.uploadTotal, 0); assert.equal(cutover.cutoverBaseline, true);
  assert.deepEqual(cutover.connections, []);
  assert.equal((await source.snapshot()).uploadTotal, 1200);
});
test('automatic fallback never opens UAC, and explicit native mode never silently uses proxy counters', async () => {
  const source = new TrafficSource({ captureMode: 'auto' });
  let calls = 0;
  source.native = { state: 'error', issue: 'elevation_required', start: async (...args) => { assert.deepEqual(args, []); throw new Error('elevation_required'); }, stop() {} };
  source.proxy = { generation: 1, snapshot: async () => { calls++; return { uploadTotal: 50 }; } };
  assert.equal((await source.snapshot()).uploadTotal, 50);
  await source.setMode('native');
  await assert.rejects(source.snapshot(), /elevation_required/);
  assert.equal(calls, 1);
});

// GitHub Windows hosted runners are elevated. This is a real ETW test with a
// separate, short-lived Codex-named process doing direct TCP (no proxy involved).
const elevated = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command',
  '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
  { encoding: 'utf8', windowsHide: true }).stdout?.trim() === 'True';
test('Windows ETW captures direct upload and download and stops its private session', { skip: !elevated && !process.env.NETWATCH_REQUIRE_NATIVE_TEST, timeout: 45000 }, async (t) => {
  assert.ok(elevated, 'The Windows CI integration test must run with administrator privileges');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netwatch-native-'));
  const exe = path.join(dir, 'codex.exe');
  fs.copyFileSync(process.execPath, exe);
  const source = new NativeSource({ root: path.resolve(import.meta.dirname, '..') });
  let child;
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end(Buffer.alloc(2 * 1024 * 1024, 3))); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (child && child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    source.stop(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  });
  await source.start();
  const port = server.address().port;
  child = spawn(exe, ['-e', `const http=require('http'); const r=http.request({host:'127.0.0.1',port:${port},method:'POST',agent:false},s=>{s.resume();s.on('end',()=>setTimeout(()=>{},4000));});r.end(Buffer.alloc(1024*1024,7));`], { windowsHide: true, stdio: 'ignore' });
  const pid = child.pid;
  let up = 0, down = 0;
  for (let i = 0; i < 16; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const snapshot = await source.snapshot();
    for (const row of snapshot.connections.filter((c) => c.metadata.processId === pid)) { up += row.upload; down += row.download; }
    if (up >= 1024 * 1024 && down >= 2 * 1024 * 1024) break;
  }
  assert.ok(up >= 1024 * 1024, `Direct upload not captured: ${up}`);
  assert.ok(down >= 2 * 1024 * 1024, `Direct download not captured: ${down}`);
  assert.ok(up < 4 * 1024 * 1024 && down < 6 * 1024 * 1024, 'Unexpected duplicate counts');
  const sessionName = `CodexNetwatch-${source.sessionId}`;
  source.stop(); assert.equal(source.state, 'stopped');
  let stopped = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (spawnSync('logman.exe', ['query', sessionName, '-ets'], { windowsHide: true, stdio: 'ignore' }).status !== 0) { stopped = true; break; }
  }
  assert.ok(stopped, 'The private ETW session must stop with the helper');
});

test('Windows ETW captures a direct UDP exchange', { skip: !elevated && !process.env.NETWATCH_REQUIRE_NATIVE_TEST, timeout: 30000 }, async (t) => {
  assert.ok(elevated, 'Windows CI native testing requires administrator privileges');
  const source = new NativeSource({ root: path.resolve(import.meta.dirname, '..') });
  const server = dgram.createSocket('udp4');
  let child;
  server.on('message', (_, peer) => server.send(Buffer.alloc(2048), peer.port, peer.address));
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (child && child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    source.stop(); server.close();
  });
  await source.start();
  child = spawn(process.execPath, ['-e', `const s=require('dgram').createSocket('udp4');s.on('message',()=>setTimeout(()=>s.close(),4000));s.send(Buffer.alloc(1024),${server.address().port},'127.0.0.1');`], { windowsHide: true, stdio: 'ignore' });
  let up = 0, down = 0;
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const row of (await source.snapshot()).connections.filter((c) => c.metadata.processId === child.pid && c.metadata.network === 'udp')) { up += row.upload; down += row.download; }
    if (up >= 1024 && down >= 2048) break;
  }
  assert.ok(up >= 1024, `UDP upload not captured: ${up}`);
  assert.ok(down >= 2048, `UDP download not captured: ${down}`);
});

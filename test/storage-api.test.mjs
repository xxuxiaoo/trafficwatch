import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { startOverviewServer } from '../src/overview-server.mjs';
import { record, connection } from './history-synthetic-fixtures.mjs';

async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('plain WAL storage archives history, reclaims pages and keeps concurrent collection and summary reads', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-storage-api-'));
  let app;
  const writers = new Map();
  t.after(async () => {
    await app?.close();
    for (const writer of writers.values()) writer.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  });
  const recent = Date.now() - 10000;
  for (const lane of ['windows', 'clash']) {
    const writer = new Store(path.join(root, lane));
    writers.set(lane, writer);
    for (const age of [120, 119, 118, 0]) record(writer, recent - age * 86400000, [connection('sample-' + age, 100, 200)]);
    writer.db.exec('CREATE TABLE spare(x BLOB); INSERT INTO spare VALUES(zeroblob(300000)); DROP TABLE spare;');
  }
  const port = await freePort();
  app = startOverviewServer({ historyRoot: root, listenPort: port, sourcePorts: [await freePort(), await freePort()], suiteSettings: {} });
  await new Promise(resolve => app.server.listening ? resolve() : app.server.once('listening', resolve));
  async function call(route, body) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-codex-flow': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  async function complete() {
    for (let attempt = 0; attempt < 150; attempt++) {
      const { status, data } = await call('/api/storage');
      assert.equal(status, 200, JSON.stringify(data));
      if (data.job?.state === 'failed') assert.fail(JSON.stringify(data.job));
      if (data.job?.state === 'completed') return data;
      await delay(30);
    }
    assert.fail('storage job did not complete');
  }
  assert.equal((await call('/api/vault/storage')).status, 404);
  assert.equal((await call('/api/storage/run', {})).status, 202);
  let snapshot = await complete();
  assert.equal(snapshot.lanes[0].archives.rows, 6);
  assert.equal(snapshot.detailsRetained, 'forever');
  assert.equal((await call('/api/storage/compact', {})).status, 202);
  record(writers.get('windows'), recent + 1000, [connection('concurrent', 42, 10)]);
  snapshot = await complete();
  assert.ok(snapshot.job.result.lanes.every(lane => lane.reclaimedBytes > 0));
  const overview = await call('/api/overview?range=all');
  assert.equal(overview.status, 200, JSON.stringify(overview.data));
  assert.equal(overview.data.machine.totals.up, 442);
  assert.equal(overview.data.clash.totals.down, 800);
  assert.equal((await call('/api/storage/cache', {})).status, 200);
  assert.equal((await call('/api/overview?range=all&fresh=1')).data.machine.totals.up, 442);
});

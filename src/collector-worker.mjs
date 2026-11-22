import { parentPort, workerData as config } from 'node:worker_threads';
import { Store } from './store.mjs';
import { historyDirectory } from './history-paths.mjs';
import { Monitor } from './monitor.mjs';
import { createCollectorApi } from './server.mjs';
import { detectSystemLocale } from './locale.mjs';

const suiteRoot = process.env.TRAFFICWATCH_SUITE_DATA_ROOT;
const lane = config.captureMode === 'mihomo' ? 'clash' : 'windows';
const storage = suiteRoot ? historyDirectory(suiteRoot, lane) : config.dataDir;
const store = new Store(storage, { onProgress: ({ stage }) => parentPort.postMessage({ stage }) });
let stopping = false;
const monitor = new Monitor(config, store, { onState: state => parentPort.postMessage({ state }) });
const request = createCollectorApi(config, store, monitor);
parentPort.on('message', async ({ id, input, stop }) => {
  if (stopping) return;
  if (stop) {
    stopping = true;
    monitor.stop();
    store.close();
    parentPort.close();
    return;
  }
  try { parentPort.postMessage({ id, result: await request(input) }); }
  catch (error) {
    // Invalid caller input is reported without echoing request data.
    const status = error instanceof SyntaxError || error.message === 'Invalid range' ? 400 : 500;
    if (status === 500) console.error('TrafficWatch collector API:', error.code || error.name);
    parentPort.postMessage({ id, error: { status } });
  }
});
parentPort.postMessage({ systemLocale: detectSystemLocale() });
parentPort.postMessage({ stage: 'starting_capture' });
// Report readiness only after the first poll has run. A disconnected source
// is reported separately (for example when Clash isn't open).
await monitor.start();
if (!stopping) {
  if (monitor.controllerIssue === 'collection') throw new Error(`initial_sample_failed:${monitor.diagnostics.lastError}`);
  parentPort.postMessage({ stage: 'ready' });
}

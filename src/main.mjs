import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { loadConfig } from './config.mjs';
import { createServer } from './server.mjs';
import { acquireInstance } from './instance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let config, instance;
try {
  config = loadConfig(root);
  instance = acquireInstance(config.dataDir);
} catch (error) {
  console.error(`Startup failed: ${error.message}`);
  process.exit(1);
}
process.once('exit', () => instance.release());

let worker, stopping = false, sequence = 0;
const pending = new Map();
const collector = {
  startupStage: 'opening_history',
  state: 'starting',
  request(input) {
    if (stopping || pending.size >= 12) return { status: 503, data: { error: 'collector_busy' } };
    const id = ++sequence;
    return new Promise(resolve => {
      // Keep an outstanding slot until the worker actually finishes the request.
      // A slow query must not let new requests build up behind it indefinitely.
      const timer = setTimeout(() => resolve({ status: 504, data: { error: 'collector_request_timeout' } }), 30000);
      pending.set(id, { resolve, timer });
      worker.postMessage({ id, input });
    });
  },
};

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const { resolve, timer } of pending.values()) {
    clearTimeout(timer);
    resolve({ status: 503, data: { error: 'collector_stopping' } });
  }
  pending.clear();
  server.close();
  server.closeAllConnections();
  if (worker) {
    worker.postMessage({ stop: true });
    setTimeout(() => {
      if (!worker) return;
      console.error('TrafficWatch collector did not stop within 5 seconds.');
      process.exit(process.exitCode || 1);
    }, 5000).unref();
  }
}

function workerFailed(error) {
  console.error(`TrafficWatch collector (${collector.startupStage}): ${error.message}`);
  if (stopping) process.exitCode = 1;
  else shutdown(1);
}

const server = createServer(config, null, null, () => shutdown(), collector);
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${config.port} is already in use. Open http://127.0.0.1:${config.port} or change CODEX_FLOW_PORT.`
    : `Server error: ${error.code}`);
  shutdown(1);
});
server.listen(config.port, '127.0.0.1', () => {
  console.log(`Codex Netwatch ${config.demo ? '[DEMO]' : ''} http://127.0.0.1:${config.port}`);
  console.log(`TrafficWatch collector startup: ${collector.startupStage}`);
  worker = new Worker(new URL('./collector-worker.mjs', import.meta.url), { workerData: config });
  worker.on('message', ({ id, result, error, stage, state, systemLocale }) => {
    if (stage) {
      collector.startupStage = stage;
      console.log(`TrafficWatch collector startup: ${stage}`);
    }
    if (state) collector.state = state;
    if (systemLocale) collector.systemLocale = systemLocale;
    if (!id) return;
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    request.resolve(error ? { status: error.status, data: { error: error.status === 400
      ? 'Invalid collector request' : 'collector_request_failed' } } : result);
  });
  worker.once('error', workerFailed);
  worker.once('exit', code => {
    worker = null;
    if (!stopping || code) workerFailed(new Error(`worker exited with code ${code}`));
  });
});
process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());

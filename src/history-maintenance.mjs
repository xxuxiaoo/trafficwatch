import { Worker } from 'node:worker_threads';

// Run SQLite maintenance and diagnostic reports outside the HTTP event loop.
export class HistoryMaintenance {
  constructor(options) {
    this.options = options;
    this.pending = new Map();
    this.sequence = 0;
  }
  start() {
    const worker = new Worker(new URL('./history-maintenance-worker.mjs', import.meta.url), { workerData: this.options });
    this.worker = worker;
    worker.on('message', ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      clearTimeout(request.timer);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    });
    worker.on('error', error => {
      console.error('TrafficWatch history worker:', error.message);
      this.fail(worker);
    });
    worker.on('exit', () => this.fail(worker));
  }
  fail(worker) {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('history_worker_unavailable'));
    }
    this.pending.clear();
  }
  request(action, input = {}) {
    if (this.closed || this.pending.size >= 16) return Promise.reject(new Error('history_busy'));
    if (!this.worker) this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('history_timeout'));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, action, input });
    });
  }
  close() {
    this.closed = true;
    const worker = this.worker;
    if (worker) {
      this.fail(worker);
      return worker.terminate();
    }
  }
}

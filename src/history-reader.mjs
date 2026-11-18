import { Worker } from 'node:worker_threads';

// A timeout must stop the SQLite work as well as reject its HTTP promise.
// At most one query executes per reader and abandoned requests leave the queue.
export class HistoryReader {
  constructor(workerData, { timeoutMs = 45000, maxQueue = 8, createWorker } = {}) {
    this.workerData = workerData; this.timeoutMs = timeoutMs; this.maxQueue = maxQueue;
    this.createWorker = createWorker || (() => new Worker(new URL('./overview-data.mjs', import.meta.url), { workerData, resourceLimits: { maxOldGenerationSizeMb: 192 } }));
    this.queue = []; this.sequence = 0; this.restarts = 0; this.completed = 0; this.failed = 0; this.lastError = null; this.closed = false;
  }
  query(payload, { signal } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('request_cancelled'));
    const key = JSON.stringify(payload);
    let task = [this.active, ...this.queue].find((item) => item?.key === key);
    if (!task) {
      if (this.queue.length >= this.maxQueue) return Promise.reject(new Error('history_busy'));
      task = { key, payload, id: ++this.sequence, subscribers: new Set() }; this.queue.push(task);
    }
    return new Promise((resolve, reject) => {
      const subscriber = { resolve, reject };
      const abort = () => {
        task.subscribers.delete(subscriber); reject(new Error('request_cancelled'));
        if (!task.subscribers.size) {
          this.queue = this.queue.filter((item) => item !== task);
          if (task === this.active) this.finish(new Error('request_cancelled'), undefined, true);
        }
      };
      subscriber.cleanup = () => signal?.removeEventListener('abort', abort);
      task.subscribers.add(subscriber); signal?.addEventListener('abort', abort, { once: true }); this.pump();
    });
  }
  pump() {
    if (this.closed || this.active || this.restarting || !this.queue.length) return;
    if (!this.worker) {
      const worker = this.worker = this.createWorker();
      worker.on('message', ({ id, data, error, event, stage, lane, done, total, unit }) => {
        if (this.worker !== worker || id !== this.active?.id) return;
        if(event==='progress'){
          if(this.active.stage!==stage||this.active.lane!==lane)this.active.stageStartedAt=Date.now();
          Object.assign(this.active,{stage,lane,done,total,unit});return;
        }
        if(!error)this.completed++;
        this.finish(error ? new Error(error) : null, data);
      });
      const failed = () => { if (this.worker === worker) this.finish(new Error('reader_unavailable'), undefined, true); };
      worker.on('error', failed); worker.on('exit', failed);
    }
    this.active = this.queue.shift();
    this.active.startedAt=Date.now();this.active.stageStartedAt=this.active.startedAt;this.active.stage='opening';
    this.timer = setTimeout(() => this.finish(new Error('history_timeout'), undefined, true), this.timeoutMs);
    this.worker.postMessage({ ...this.active.payload, id: this.active.id, now: Date.now() });
  }
  finish(error, data, replace = false) {
    clearTimeout(this.timer);
    const active = this.active; this.active = null;
    if(active)this.lastTask={payload:active.payload,state:error?'error':'complete',error:error?.message,elapsedMs:Date.now()-active.startedAt,finishedAt:Date.now()};
    if(active&&error&&error.message!=='request_cancelled'){this.failed++;this.lastError=error.message;}
    else if(active&&!error)this.lastError=null;
    if (active) for (const subscriber of active.subscribers) {
      subscriber.cleanup(); error ? subscriber.reject(error) : subscriber.resolve(data);
    }
    if (replace && this.worker) {
      const worker = this.worker; this.worker = null; this.restarting = true; this.restarts++;
      this.termination=Promise.resolve(worker.terminate()).finally(() => { this.restarting = false; this.pump(); });
    } else this.pump();
  }
  stats() { return { active: Boolean(this.active), queued: this.queue.length, restarts: this.restarts, completed: this.completed, failed:this.failed,lastError:this.lastError,
    ...(this.active?{stage:this.active.stage,lane:this.active.lane,elapsedMs:Date.now()-this.active.startedAt}:{}) }; }
  progressFor(selector) {
    const matches=task=>task&&Object.entries(selector).every(([key,value])=>task.payload[key]===value);
    if(matches(this.active)){
      const {stage,lane,done,total,unit,startedAt,stageStartedAt}=this.active;
      return {state:'running',stage,lane,done,total,unit,startedAt,elapsedMs:Date.now()-startedAt,stageElapsedMs:Date.now()-stageStartedAt};
    }
    const position=this.queue.findIndex(matches);
    if(position>=0){
      const blocker=this.active?{stage:this.active.stage,lane:this.active.lane,elapsedMs:Date.now()-this.active.startedAt}:this.restarting?{stage:'reader_restart'}:null;
      return {state:'queued',position:position+1,ahead:position,blocker};
    }
    if(matches(this.lastTask)&&Date.now()-this.lastTask.finishedAt<60000){const {state,error,elapsedMs}=this.lastTask;return {state,error,elapsedMs};}
    return {state:'idle'};
  }
  close() {
    this.closed = true;
    for (const task of this.queue.splice(0)) for (const subscriber of task.subscribers) { subscriber.cleanup(); subscriber.reject(new Error('request_cancelled')); }
    this.finish(new Error('request_cancelled'), undefined, true);
    return this.termination;
  }
}

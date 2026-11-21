import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Store } from './store.mjs';
import { DiagnosticHistory } from './ai-diagnostic-store.mjs';
import { historyDirectory, historyFilename } from './history-paths.mjs';
import { archiveOldHistory, storageSnapshot, saveStoragePolicy, storagePolicy } from './storage-manager.mjs';
import { archiveCutoff } from './history-archive.mjs';
import { removeSummaryCache } from './storage-files.mjs';

const { dataRoot, cacheRoot, singleCollector } = workerData;
const stores = new Map();
const trafficLanes = singleCollector ? [singleCollector === 'mihomo' ? 'clash' : 'windows'] : ['windows', 'clash'];
let diagnostics, job, running, snapshot, pauseArchive = false;

function openStores() {
  for (const lane of trafficLanes) {
    if (stores.has(lane)) continue;
    const directory = historyDirectory(dataRoot, lane, { singleCollector });
    if (fs.existsSync(path.join(directory, historyFilename(lane)))) stores.set(lane, new Store(directory));
  }
  if (!stores.size) throw new Error('storage_no_history');
}

function status(fresh) {
  openStores();
  if (!snapshot || fresh || Date.now() - snapshot.generatedAt > 60000) snapshot = storageSnapshot(dataRoot, stores, job);
  return { ...snapshot, job };
}

async function compact() {
  const lanes = [];
  // Existing databases can keep and reuse their free pages even when created
  // without incremental vacuum. Report those cases explicitly in the UI.
  for (const [lane, store] of stores) {
    const { db } = store;
    const before = db.prepare('PRAGMA freelist_count').get().freelist_count;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const incremental = db.prepare('PRAGMA auto_vacuum').get().auto_vacuum === 2;
    job = { ...job, stage: 'compact', lane, updatedAt: Date.now() };
    let remaining = before;
    if (incremental) {
      while (remaining) {
        db.exec('PRAGMA incremental_vacuum(512)');
        const next = db.prepare('PRAGMA freelist_count').get().freelist_count;
        if (next >= remaining) throw new Error('storage_compact_no_progress');
        remaining = next;
        await delay(40);
      }
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    }
    lanes.push({ lane, reclaimedBytes: (before - remaining) * pageSize, reusableOnly: !incremental && before > 0 });
  }
  return { lanes };
}

function startJob(operation) {
  if (running) throw new Error('storage_busy');
  openStores();
  pauseArchive = false;
  job = { operation, state: 'running', stage: 'preparing', startedAt: Date.now(), updatedAt: Date.now() };
  running = delay(0).then(() => operation === 'compact' ? compact() : archiveOldHistory(stores, {
    progress: progress => { job = { ...job, ...progress, updatedAt: Date.now() }; },
    shouldStop: () => pauseArchive,
  })).then(result => {
    job = { ...job, state: result.paused ? 'paused' : 'completed', stage: 'complete', result, updatedAt: Date.now() };
  }).catch(error => {
    console.error('TrafficWatch storage maintenance:', error.message);
    job = { ...job, state: 'failed', error: error.message, updatedAt: Date.now() };
  }).finally(() => { running = null; snapshot = null; });
  return { job };
}

function runAutomaticArchive() {
  if (running || !trafficLanes.some(lane => fs.existsSync(path.join(historyDirectory(dataRoot, lane, { singleCollector }), historyFilename(lane))))) return;
  openStores();
  if ([...stores.values()].some(store => {
    const policy = storagePolicy(store);
    if (!policy.enabled) return false;
    const cutoff = archiveCutoff(Date.now(), policy.onlineDays);
    return store.db.prepare('SELECT 1 FROM samples WHERE at<? LIMIT 1').get(cutoff) ||
      store.db.prepare('SELECT 1 FROM buckets WHERE minute<? LIMIT 1').get(cutoff);
  })) startJob('archive');
}
function scheduledArchive() {
  try { runAutomaticArchive(); }
  catch (error) { console.error('TrafficWatch scheduled history archive:', error.message); }
}
setTimeout(scheduledArchive, 15000).unref();
setInterval(scheduledArchive, 6 * 3600000).unref();

parentPort.on('message', ({ id, action, input }) => {
  try {
    let result;
    switch (action) {
      case 'storage-status': result = status(input.fresh); break;
      case 'storage-policy':
        openStores();
        result = { policy: saveStoragePolicy(stores, input.policy) };
        if (!input.policy.enabled) pauseArchive = true;
        snapshot = null;
        break;
      case 'storage-compact': result = startJob('compact'); break;
      case 'storage-run': result = startJob('archive'); break;
      case 'storage-cache':
        removeSummaryCache(path.join(cacheRoot, 'windows-programs-v2.sqlite'));
        snapshot = null;
        job = { operation: 'purge-cache', state: 'completed', stage: 'complete', updatedAt: Date.now() };
        result = { job };
        break;
      case 'diagnostic-query':
        diagnostics ??= new DiagnosticHistory(dataRoot);
        result = diagnostics.query({ ...input, windows: [{ from: 0, to: Number.MAX_SAFE_INTEGER }], owner: true });
        break;
      case 'diagnostic-attachment':
      case 'diagnostic-delete-attachment':
        diagnostics ??= new DiagnosticHistory(dataRoot);
        result = action === 'diagnostic-attachment' ? diagnostics.attachment(input.id) : diagnostics.deleteAttachment(input.id);
        break;
      default: throw new Error('invalid_history_operation');
    }
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});

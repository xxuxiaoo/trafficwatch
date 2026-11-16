import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync as PlainDatabase } from 'node:sqlite';
import { sealPacket, openPacket, packetFormat } from './vault-crypto.mjs';
import { dpapi } from './vault-platform.mjs';
import {drainSealedQueue} from './sealed-queue.mjs';

// Only capture preferences are public. Observed process names, domains, session
// titles and byte counts always go inside the encrypted envelope.
const PREFERENCES = new Set(['harnessApps', 'captureMode', 'retentionDays', 'alertMBPerMinute', 'budget']);
export class SealedStore {
  constructor(dir, metadata) {
    this.dir = dir; this.metadata = metadata; this.sealed = true;
    this.lane = path.basename(dir); this.pending = []; this.preferences = {};
    const signingFile=path.join(path.dirname(dir),'vault','capture-signing.dpapi');
    this.signingKey=metadata.capturePublicKey ? dpapi(fs.readFileSync(signingFile),{scope:'machine',decrypt:true}) : undefined;
    if (!['windows', 'clash'].includes(this.lane)) throw new Error('invalid_vault_lane');
    fs.mkdirSync(dir, { recursive: true });
    this.preferencesPath = path.join(dir, 'capture-preferences.json');
    if (fs.existsSync(this.preferencesPath)) this.preferences = JSON.parse(fs.readFileSync(this.preferencesPath, 'utf8'));
    this.db = new PlainDatabase(path.join(dir, 'ingest.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS envelopes(sequence INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,payload BLOB NOT NULL);`);
    this.append = this.db.prepare('INSERT INTO envelopes(id,payload) VALUES (?,?)');
    this.flushTimer=setInterval(()=>{try{this.flush();}catch{process.stderr.write('Encrypted capture storage failed.\n');process.exit(1);}},2000).unref();
  }
  queue(method, args) {
    this.pending.push({ method, args });
    if (this.pending.length >= 128) this.flush();
  }
  flush() {
    if (!this.pending.length) return;
    const id = crypto.randomUUID();
    const packet = sealPacket(this.pending, this.metadata.publicKey, { format: packetFormat, vault: this.metadata.id, lane: this.lane, id },this.signingKey);
    this.append.run(id, Buffer.from(JSON.stringify(packet)));
    this.pending = [];
  }
  record(sample) { this.queue('record', [sample]); this.last = sample.at; this.first ??= sample.at; this.flush(); return true; }
  saveSession(...args) { this.queue('saveSession', args); }
  excludeSessions() {}
  set(key, value) {
    if (PREFERENCES.has(key)) {
      this.preferences[key] = value;
      const temporary = this.preferencesPath + '.pending';
      fs.writeFileSync(temporary, JSON.stringify(this.preferences)); fs.renameSync(temporary, this.preferencesPath);
    }
    this.queue('set', [key, value]);
  }
  get(key, fallback) { return PREFERENCES.has(key) ? this.preferences[key] ?? fallback : fallback; }
  setHarnessApps(apps) { this.set('harnessApps', apps); return apps; }
  firstAt() { return this.first ?? null; }
  lastAt() { return this.last ?? null; }
  openGap(reason, from) { const id = crypto.randomUUID(); this.queue('openGap', [id, reason, from]); return id; }
  closeGap(id, to) { this.queue('closeGap', [id, to]); }
  closeOpenGaps(to) { this.queue('closeOpenGaps', [to]); }
  alert(...args) { this.queue('alert', args); }
  anomaly(...args) { this.queue('anomaly', args); }
  // History budgets and retention are handled by the unlocked importer.
  checkBudgets() {}
  prune() { this.flush(); }
  close() { clearInterval(this.flushTimer);this.flush(); this.db.close();this.signingKey?.fill(0); }
}

export function initializeImport(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS vault_imports(id TEXT PRIMARY KEY,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS vault_deletions(start_at INTEGER NOT NULL,end_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vault_gap_ids(id TEXT PRIMARY KEY,gap_id INTEGER NOT NULL);`);
}
export function importEnvelope(store, envelope, metadata, secrets) {
  const raw = Buffer.from(envelope.payload), digest = crypto.createHash('sha256').update(raw).digest('hex');
  const previous = store.db.prepare('SELECT digest FROM vault_imports WHERE id=?').get(envelope.id);
  if (previous) { if (previous.digest !== digest) throw new Error('ingest_id_conflict'); return false; }
  const packet = JSON.parse(raw.toString('utf8'));
  if (packet.header?.vault !== metadata.id || packet.header?.id !== envelope.id || packet.header?.lane !== store.vaultLane) throw new Error('ingest_header_mismatch');
  const operations = openPacket(packet, secrets.privateKey,metadata.capturePublicKey);
  if (!Array.isArray(operations) || operations.length > 1024) throw new Error('invalid_ingest_operations');
  store.db.exec('SAVEPOINT vault_import_envelope');
  try {
    let backfilled=false;
    for (const { method, args } of operations) {
      if (!Array.isArray(args)) throw new Error('invalid_ingest_operation');
      const timestamp=method==='record'?args[0]?.at:method==='saveSession'?args[0]?.activity:method==='alert'?args[0]:method==='anomaly'?args[0]?.to:undefined;
      if(timestamp!==undefined&&store.db.prepare('SELECT 1 FROM vault_deletions WHERE ?>=start_at AND ?<end_at LIMIT 1').get(timestamp,timestamp))continue;
      if (method === 'record') {
        const inserted=store.record(args[0], { transaction: false });
        if(inserted!==false&&timestamp<Math.floor((Date.now()-120000)/3600000)*3600000)backfilled=true;
      }
      else if (['saveSession', 'set', 'alert', 'anomaly', 'closeOpenGaps'].includes(method)) store[method](...args);
      else if (method === 'openGap') {
        const gap = store.openGap(args[1], args[2]);
        store.db.prepare('INSERT INTO vault_gap_ids VALUES (?,?)').run(args[0], gap);
      } else if (method === 'closeGap') {
        const gap = store.db.prepare('SELECT gap_id FROM vault_gap_ids WHERE id=?').get(args[0]);
        if (gap) store.closeGap(gap.gap_id, args[1]);
      } else throw new Error('invalid_ingest_operation');
    }
    // Completed-hour summaries can have been built while this older queue was
    // still importing. Invalidate them in the same transaction as late bytes.
    if(backfilled)store.set('vaultDataRevision',store.get('vaultDataRevision',0)+1);
    store.db.prepare('INSERT INTO vault_imports VALUES (?,?)').run(envelope.id, digest);
    store.db.exec('RELEASE vault_import_envelope'); return true;
  } catch (error) { store.db.exec('ROLLBACK TO vault_import_envelope;RELEASE vault_import_envelope'); throw error; }
}

export function drainIngestBatch(store, metadata, secrets, options = {}) {
  return drainSealedQueue(path.join(store.vaultDir,'ingest.sqlite'),store.db,envelope=>importEnvelope(store,envelope,metadata,secrets),options);
}
export function drainIngest(store, metadata, secrets, options) {return drainIngestBatch(store,metadata,secrets,options).count;}

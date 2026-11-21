import crypto from 'node:crypto';
import { openPacket } from './legacy-keys.mjs';

export function initializeImport(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS vault_imports(id TEXT PRIMARY KEY,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS vault_deletions(start_at INTEGER NOT NULL,end_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vault_gap_ids(id TEXT PRIMARY KEY,gap_id INTEGER NOT NULL);`);
}
const importReaders = new WeakMap();
function importReader(store, metadata, secrets) {
  const existing = importReaders.get(store);
  if (existing?.secrets === secrets && existing.metadata === metadata) return existing;
  const reader = {
    metadata, secrets,
    privateKey: crypto.createPrivateKey(secrets.privateKey),
    signingKey: metadata.capturePublicKey ? crypto.createPublicKey(metadata.capturePublicKey) : undefined,
    previous: store.db.prepare('SELECT digest FROM vault_imports WHERE id=?'),
    remember: store.db.prepare('INSERT INTO vault_imports VALUES (?,?)'),
    deleted: store.db.prepare('SELECT 1 FROM vault_deletions WHERE ?>=start_at AND ?<end_at LIMIT 1'),
  };
  importReaders.set(store, reader);
  return reader;
}

export function importEnvelope(store, envelope, metadata, secrets) {
  const reader = importReader(store, metadata, secrets);
  const raw = Buffer.from(envelope.payload.buffer, envelope.payload.byteOffset, envelope.payload.byteLength);
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  const previous = reader.previous.get(envelope.id);
  if (previous) { if (previous.digest !== digest) throw new Error('ingest_id_conflict'); return false; }
  const packet = JSON.parse(raw.toString('utf8'));
  if (packet.header?.vault !== metadata.id || packet.header?.id !== envelope.id || packet.header?.lane !== store.vaultLane) throw new Error('ingest_header_mismatch');
  const operations = openPacket(packet, reader.privateKey, reader.signingKey);
  if (!Array.isArray(operations) || operations.length > 1024) throw new Error('invalid_ingest_operations');
  store.db.exec('SAVEPOINT vault_import_envelope');
  try {
    const packetDaily=new Map();
    for (const { method, args } of operations) {
      if (!Array.isArray(args)) throw new Error('invalid_ingest_operation');
      const timestamp=method==='record'?args[0]?.at:method==='saveSession'?args[0]?.activity:method==='alert'?args[0]:method==='anomaly'?args[0]?.to:undefined;
      if(timestamp!==undefined&&reader.deleted.get(timestamp,timestamp))continue;
      if (method === 'record') {
        store.record(args[0], { transaction: false,dailyAccumulator:packetDaily });
      }
      else if (method === 'set' && args[0] === 'airportGroups') continue;
      else if (['saveSession', 'set', 'alert', 'anomaly', 'closeOpenGaps'].includes(method)) store[method](...args);
      else if (method === 'openGap') {
        const gap = store.openGap(args[1], args[2]);
        store.db.prepare('INSERT INTO vault_gap_ids VALUES (?,?)').run(args[0], gap);
      } else if (method === 'closeGap') {
        const gap = store.db.prepare('SELECT gap_id FROM vault_gap_ids WHERE id=?').get(args[0]);
        if (gap) store.closeGap(gap.gap_id, args[1]);
      } else throw new Error('invalid_ingest_operation');
    }
    reader.remember.run(envelope.id, digest);
    for (const value of packetDaily.values()) {
      store.insertDaily.run(value.day,value.codex_up,value.codex_down,value.all_up,value.all_down,value.first_at,value.last_at);
    }
    store.db.exec('RELEASE vault_import_envelope');
    return true;
  } catch (error) { store.db.exec('ROLLBACK TO vault_import_envelope;RELEASE vault_import_envelope'); throw error; }
}

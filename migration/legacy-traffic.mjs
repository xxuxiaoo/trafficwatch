import crypto from 'node:crypto';
import { openPacket } from './legacy-keys.mjs';
import { COLLECTION_GAP_REASONS, validGapTime } from '../src/store.mjs';

export class InvalidLegacyPacket extends Error {}

export function packetDigest(payload) {
  const bytes = payload instanceof Uint8Array ? payload : JSON.stringify([typeof payload, payload]);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function decodeEnvelope(envelope, vaultId, lane, privateKey, signingKey) {
  if (!(envelope.payload instanceof Uint8Array)) throw new InvalidLegacyPacket('invalid_ingest_blob');
  let packet;
  const { buffer, byteOffset, byteLength } = envelope.payload;
  try { packet = JSON.parse(Buffer.from(buffer, byteOffset, byteLength).toString('utf8')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new InvalidLegacyPacket('invalid_ingest_json', { cause: error });
  }
  if (packet?.header?.vault !== vaultId || packet.header.id !== envelope.id || packet.header.lane !== lane) {
    throw new InvalidLegacyPacket('ingest_header_mismatch');
  }
  try { return openPacket(packet, privateKey, signingKey); }
  catch (error) {
    if (error instanceof SyntaxError) throw new InvalidLegacyPacket('invalid_ingest_plaintext_json', { cause: error });
    if (['invalid_encrypted_packet', 'invalid_packet_signature', 'Unsupported state or unable to authenticate data'].includes(error.message) ||
        ['ERR_OSSL_RSA_OAEP_DECODING_ERROR', 'ERR_OSSL_RSA_DATA_GREATER_THAN_MOD_LEN',
          'ERR_CRYPTO_INVALID_IV', 'ERR_CRYPTO_INVALID_AUTH_TAG', 'ERR_BUFFER_TOO_LARGE', 'Z_DATA_ERROR', 'Z_BUF_ERROR'].includes(error.code)) {
      throw new InvalidLegacyPacket(`ingest_decode_failed:${error.code || error.message}`, { cause: error });
    }
    throw error;
  }
}

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
    gap: store.db.prepare(`SELECT gap_id, reason, started_at FROM vault_gap_ids
      LEFT JOIN collection_gaps ON collection_gaps.id=vault_gap_ids.gap_id WHERE vault_gap_ids.id=?`),
    rememberGap: store.db.prepare('INSERT INTO vault_gap_ids VALUES (?,?)'),
  };
  importReaders.set(store, reader);
  return reader;
}

function legacyGapTime(value) {
  // Older boundary values may be decimal milliseconds in text. Do not infer
  // missing endpoints or rescale seconds into milliseconds.
  const time = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  return validGapTime(time) ? time : null;
}

function applyGap(store, reader, method, args) {
  if (method === 'closeOpenGaps') {
    if (args[0] == null) return;
    const end = legacyGapTime(args[0]);
    if (end === null) return 'invalid_gap_end';
    store.closeOpenGaps(end);
    return;
  }
  const [id, value, startedAt] = args;
  if (typeof id !== 'string' || !id) return 'invalid_gap_id';
  const existing = reader.gap.get(id);
  if (method === 'openGap') {
    if (!COLLECTION_GAP_REASONS.includes(value)) return 'invalid_gap_reason';
    const start = legacyGapTime(startedAt);
    if (start === null) return 'invalid_gap_start';
    if (existing) {
      // The old mapping can outlive a gap that was pruned or deleted.
      if (existing.reason !== null && (existing.reason !== value || existing.started_at !== start)) return 'gap_id_conflict';
      return;
    }
    reader.rememberGap.run(id, store.openGap(value, start));
  } else if (value != null) {
    const end = legacyGapTime(value);
    if (end === null) return 'invalid_gap_end';
    if (!existing) return 'unmatched_gap_id';
    store.closeGap(existing.gap_id, end);
  }
}

export function importEnvelope(store, envelope, digest, metadata, secrets) {
  const reader = importReader(store, metadata, secrets);
  const previous = reader.previous.get(envelope.id);
  if (previous) {
    if (previous.digest !== digest) throw new InvalidLegacyPacket('ingest_id_conflict');
    return { status: 'alreadyImported', issues: [] };
  }
  const operations = decodeEnvelope(envelope, metadata.id, store.vaultLane, reader.privateKey, reader.signingKey);
  if (!Array.isArray(operations) || operations.length > 1024) throw new InvalidLegacyPacket('invalid_ingest_operations');
  store.db.exec('SAVEPOINT vault_import_envelope');
  try {
    const packetDaily = new Map(), issues = [];
    let proxyControllerGap = false;
    for (const [index, operation] of operations.entries()) {
      const { method, args } = operation || {};
      const addIssue = reason => issues.push({ operation: index + 1, reason });
      if (!Array.isArray(args)) { addIssue('invalid_ingest_operation_arguments'); continue; }
      if (['openGap', 'closeGap', 'closeOpenGaps'].includes(method)) {
        const reason = applyGap(store, reader, method, args);
        if (reason) addIssue(reason);
        else if (method === 'openGap' && args[1] === 'proxy_controller_unavailable') proxyControllerGap = true;
        continue;
      }
      if (method === 'anomaly') {
        const value = args[0];
        if (typeof value?.kind !== 'string' || !value.kind || !validGapTime(value.from) || !validGapTime(value.to) || value.to < value.from) {
          addIssue('invalid_legacy_anomaly'); continue;
        }
      }
      if (method === 'record' && !validGapTime(args[0]?.at)) { addIssue('invalid_sample_time'); continue; }
      const timestamp = method === 'record' ? args[0].at : method === 'saveSession' ? args[0]?.activity :
        method === 'alert' ? args[0] : method === 'anomaly' ? args[0].to : undefined;
      if (timestamp !== undefined && reader.deleted.get(timestamp, timestamp)) continue;
      if (method === 'record') store.record(args[0], { transaction: false, dailyAccumulator: packetDaily });
      else if (method === 'set' && args[0] === 'airportGroups') continue;
      else if (['saveSession', 'set', 'alert', 'anomaly'].includes(method)) store[method](...args);
      else addIssue('unsupported_ingest_operation');
    }
    const applied = !issues.length || issues.length < operations.length;
    if (applied) reader.remember.run(envelope.id, digest);
    for (const value of packetDaily.values()) {
      store.insertDaily.run(value.day, value.codex_up, value.codex_down, value.all_up, value.all_down, value.first_at, value.last_at);
    }
    store.db.exec('RELEASE vault_import_envelope');
    return { status: applied ? 'added' : 'quarantined', issues, proxyControllerGap };
  } catch (error) { store.db.exec('ROLLBACK TO vault_import_envelope;RELEASE vault_import_envelope'); throw error; }
}

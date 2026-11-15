import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVaultKeys, unlockVaultKeys, changeVaultPassword, sealPacket, openPacket, packetFormat, purposeKey } from '../src/vault-crypto.mjs';
import { DatabaseSync } from '../src/database.mjs';

const password = 'synthetic-vault-password-only';
let created;
test.before(async () => { created = await createVaultKeys(password, 'synthetic-owner'); });

test('password and independent recovery wrapping unlock the same keys without storing a password', async () => {
  assert.deepEqual(await unlockVaultKeys(created.metadata, password), created.secrets);
  assert.deepEqual(await unlockVaultKeys(created.metadata, created.recoveryCode, true), created.secrets);
  assert.ok(!JSON.stringify(created.metadata).includes(password));
  await assert.rejects(unlockVaultKeys(created.metadata, 'another-synthetic-password'), /wrong_password/);
  await assert.rejects(unlockVaultKeys({ ...created.metadata, ownerSid: 'other-owner' }, password), /wrong_password/);
  await assert.rejects(unlockVaultKeys({ ...created.metadata, kdf: { ...created.metadata.kdf, memory: 2147483647 } }, password), /unsupported_password_parameters/);
  const changed = await changeVaultPassword(created.metadata, created.secrets, 'replacement-synthetic-password');
  assert.deepEqual(await unlockVaultKeys(changed, 'replacement-synthetic-password'), created.secrets);
  await assert.rejects(unlockVaultKeys(changed, password), /wrong_password/);
  assert.deepEqual(await unlockVaultKeys(changed, created.recoveryCode, true), created.secrets);
});

test('sealed collector packets require the reading private key and reject changed content, lane and signatures', () => {
  const signing = crypto.generateKeyPairSync('ed25519');
  const record = { host: 'private-canary.example.test', process: 'synthetic.exe', up: 100, down: 200 };
  const packet = sealPacket(record, created.metadata.publicKey, { format: packetFormat, lane: 'windows', id: crypto.randomUUID() }, signing.privateKey);
  assert.deepEqual(openPacket(packet, created.secrets.privateKey, signing.publicKey), record);
  assert.ok(!JSON.stringify(packet).includes(record.host));
  assert.throws(() => openPacket({ ...packet, header: { ...packet.header, lane: 'clash' } }, created.secrets.privateKey, signing.publicKey), /invalid_packet_signature/);
  const damaged = { ...packet, ciphertext: packet.ciphertext.slice(0, -4) + 'AAAA' };
  assert.throws(() => openPacket(damaged, created.secrets.privateKey));
  assert.throws(() => openPacket(packet, created.metadata.publicKey));
});

test('database, WAL and rollback-related files contain encrypted pages and reject a wrong key', testContext => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trafficwatch-vault-'));
  assert.ok(path.resolve(fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep + 'trafficwatch-vault-'));
  testContext.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const filename = path.join(fixtureRoot, 'encrypted.sqlite');
  const key = purposeKey(Buffer.from(created.secrets.master, 'base64'), 'test-database');
  const marker = 'PRIVATE_TRAFFIC_CANARY_' + crypto.randomUUID();
  const connection = new DatabaseSync(filename, { encryptionKey: key });
  connection.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (value TEXT)');
  connection.prepare('INSERT INTO records VALUES (?)').run(marker);
  for (const name of fs.readdirSync(fixtureRoot)) assert.ok(!fs.readFileSync(path.join(fixtureRoot, name)).includes(Buffer.from(marker)), name);
  assert.notEqual(fs.readFileSync(filename).subarray(0, 15).toString(), 'SQLite format 3');
  connection.close();
  assert.throws(() => new DatabaseSync(filename, { encryptionKey: crypto.randomBytes(32) }));
  const reopened = new DatabaseSync(filename, { encryptionKey: key, readOnly: true });
  assert.equal(reopened.prepare('SELECT value FROM records').get().value, marker);
  reopened.close(); key.fill(0);
});

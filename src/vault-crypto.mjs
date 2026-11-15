import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const deriveArgon = promisify(crypto.argon2);
const FORMAT = 'trafficwatch-vault-1';
const MAX_PACKET = 32 * 1024 * 1024;
export const PASSWORD_KDF = Object.freeze({ memory: 65536, passes: 3, parallelism: 2, tagLength: 32 });
const encoded = value => Buffer.from(value).toString('base64');
const decoded = (value, maximum = MAX_PACKET) => {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid_encrypted_packet');
  const result = Buffer.from(value, 'base64');
  if (result.length > maximum || result.toString('base64') !== value) throw new Error('invalid_encrypted_packet');
  return result;
};

export function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
export function tokenDigest(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
export function purposeKey(master, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `TrafficWatch/${FORMAT}/${purpose}`, 32));
}
export function sealValue(value, key, context) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const plaintext = Buffer.from(JSON.stringify(value));
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { nonce: encoded(nonce), tag: encoded(cipher.getAuthTag()), ciphertext: encoded(ciphertext) };
  } finally { plaintext.fill(0); }
}

export function openValue(packet, key, context) {
  const nonce = decoded(packet?.nonce, 12), tag = decoded(packet?.tag, 16);
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid_encrypted_packet');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(decoded(packet.ciphertext)), decipher.final()]);
  try { return JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
}

async function passwordKey(password, salt, parameters = PASSWORD_KDF) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || decoded(salt, 16).length !== 16) throw new Error('invalid_password');
  if (parameters.memory !== PASSWORD_KDF.memory || parameters.passes !== PASSWORD_KDF.passes || parameters.parallelism !== PASSWORD_KDF.parallelism || parameters.tagLength !== 32) throw new Error('unsupported_password_parameters');
  const message = Buffer.from(password);
  try { return await deriveArgon('argon2id', { ...parameters, message, nonce: decoded(salt, 16) }); }
  finally { message.fill(0); }
}

export async function createVaultKeys(password, ownerSid = '') {
  if (typeof password !== 'string' || [...password].length < 10 || Buffer.byteLength(password) > 1024) throw new Error('password_too_short');
  const pair = await promisify(crypto.generateKeyPair)('rsa', { modulusLength: 3072, publicExponent: 65537 });
  const signing = crypto.generateKeyPairSync('ed25519');
  const master = crypto.randomBytes(32), salt = encoded(crypto.randomBytes(16)), id = crypto.randomUUID();
  const secrets = { master: encoded(master), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), commandKey: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const context = `${FORMAT}/${id}/${ownerSid}`;
  const passwordWrapping = await passwordKey(password, salt);
  const recoveryBytes = crypto.randomBytes(32), recoveryKey = purposeKey(recoveryBytes, 'recovery');
  try {
    const metadata = { format: FORMAT, id, ownerSid, createdAt: Date.now(), publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }), commandPublicKey: signing.publicKey.export({ type: 'spki', format: 'pem' }), kdf: { ...PASSWORD_KDF, salt }, password: sealValue(secrets, passwordWrapping, context + '/password'), recovery: sealValue(secrets, recoveryKey, context + '/recovery') };
    return { metadata, secrets, recoveryCode: 'TW-' + recoveryBytes.toString('hex').toUpperCase().match(/.{1,8}/g).join('-') };
  } finally { passwordWrapping.fill(0); recoveryKey.fill(0); recoveryBytes.fill(0); master.fill(0); }
}

export async function unlockVaultKeys(metadata, credential, recovery = false) {
  if (metadata?.format !== FORMAT || !/^[a-f0-9-]{36}$/.test(metadata.id || '')) throw new Error('invalid_vault_metadata');
  let wrapping;
  if (recovery) {
    const normalized = String(credential).replace(/^TW-/i, '').replaceAll('-', '').replaceAll(' ', '');
    if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new Error('wrong_password');
    const recoveryBytes = Buffer.from(normalized, 'hex');
    try { wrapping = purposeKey(recoveryBytes, 'recovery'); } finally { recoveryBytes.fill(0); }
  } else wrapping = await passwordKey(credential, metadata.kdf.salt, metadata.kdf);
  try {
    return openValue(metadata[recovery ? 'recovery' : 'password'], wrapping, `${FORMAT}/${metadata.id}/${metadata.ownerSid}/${recovery ? 'recovery' : 'password'}`);
  } catch { throw new Error('wrong_password'); } finally { wrapping.fill(0); }
}

export async function changeVaultPassword(metadata, secrets, password) {
  if (typeof password !== 'string' || [...password].length < 10 || Buffer.byteLength(password) > 1024) throw new Error('password_too_short');
  const salt = encoded(crypto.randomBytes(16)), wrapping = await passwordKey(password, salt);
  try { return { ...metadata, kdf: { ...PASSWORD_KDF, salt }, password: sealValue(secrets, wrapping, `${FORMAT}/${metadata.id}/${metadata.ownerSid}/password`) }; }
  finally { wrapping.fill(0); }
}

export function sealPacket(value, publicKey, header, signingKey) {
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12);
  const associated = Buffer.from(JSON.stringify(header));
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length > MAX_PACKET) { key.fill(0); raw.fill(0); throw new Error('packet_too_large'); }
  const plaintext = deflateRawSync(raw); raw.fill(0);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(associated);
    const packet = { header, key: encoded(crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, key)), nonce: encoded(nonce), ciphertext: encoded(Buffer.concat([cipher.update(plaintext), cipher.final()])), tag: encoded(cipher.getAuthTag()) };
    if (signingKey) packet.signature = encoded(crypto.sign(null, Buffer.from(JSON.stringify(packet)), signingKey));
    return packet;
  } finally { key.fill(0); plaintext.fill(0); }
}

export function openPacket(packet, privateKey, signingPublicKey) {
  if (!packet?.header || packet.header.format !== FORMAT || !['windows', 'clash', 'audit', 'diagnostics'].includes(packet.header.lane)) throw new Error('invalid_encrypted_packet');
  const { signature, ...unsigned } = packet;
  if (signingPublicKey && (!signature || !crypto.verify(null, Buffer.from(JSON.stringify(unsigned)), signingPublicKey, decoded(signature, 128)))) throw new Error('invalid_packet_signature');
  const key = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, decoded(packet.key, 1024));
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, decoded(packet.nonce, 12));
    decipher.setAAD(Buffer.from(JSON.stringify(packet.header))); decipher.setAuthTag(decoded(packet.tag, 16));
    const compressed = Buffer.concat([decipher.update(decoded(packet.ciphertext)), decipher.final()]);
    const plaintext = inflateRawSync(compressed, { maxOutputLength: MAX_PACKET });
    try { return JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); compressed.fill(0); }
  } finally { key.fill(0); }
}

export const packetFormat = FORMAT;

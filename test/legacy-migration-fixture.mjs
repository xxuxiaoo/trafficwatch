import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {deflateRawSync} from 'node:zlib';
import {purposeKey, passwordKey, PASSWORD_KDF, packetFormat as FORMAT} from '../migration/legacy-keys.mjs';
const encoded = value => Buffer.from(value).toString('base64');
const MAX_PACKET = 32 * 1024 * 1024;
export const packetFormat = FORMAT;
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

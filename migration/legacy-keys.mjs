import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const deriveArgon = promisify(crypto.argon2);
const FORMAT = 'trafficwatch-vault-1';
const MAX_PACKET = 32 * 1024 * 1024;
export const PASSWORD_KDF = Object.freeze({ memory: 65536, passes: 3, parallelism: 2, tagLength: 32 });
const decoded = (value, maximum = MAX_PACKET) => {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('invalid_encrypted_packet');
  const result = Buffer.from(value, 'base64');
  if (result.length > maximum || result.toString('base64') !== value) throw new Error('invalid_encrypted_packet');
  return result;
};

export function purposeKey(master, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), `TrafficWatch/${FORMAT}/${purpose}`, 32));
}
export function openValue(packet, key, context) {
  const nonce = decoded(packet?.nonce, 12), tag = decoded(packet?.tag, 16);
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid_encrypted_packet');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(decoded(packet.ciphertext)), decipher.final()]);
  try { return JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
}

export async function passwordKey(password, salt, parameters = PASSWORD_KDF) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || decoded(salt, 16).length !== 16) throw new Error('invalid_password');
  if (parameters.memory !== PASSWORD_KDF.memory || parameters.passes !== PASSWORD_KDF.passes || parameters.parallelism !== PASSWORD_KDF.parallelism || parameters.tagLength !== 32) throw new Error('unsupported_password_parameters');
  const message = Buffer.from(password);
  try { return await deriveArgon('argon2id', { ...parameters, message, nonce: decoded(salt, 16) }); }
  finally { message.fill(0); }
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

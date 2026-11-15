import path from 'node:path';
import { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
let CipherDatabase;

const keys = new Map();
export function configureDatabaseKeys(entries = []) {
  for (const key of keys.values()) key.fill(0);
  keys.clear();
  for (const [filename, key] of entries) keys.set(path.resolve(filename).toLowerCase(), Buffer.from(key));
}
export function databaseKey(filename) { return keys.get(path.resolve(filename).toLowerCase()); }

export class DatabaseSync {
  constructor(filename, options = {}) {
    const key = options.encryptionKey || databaseKey(filename);
    if (!key) return new NativeDatabase(filename, options);
    CipherDatabase??=require('better-sqlite3-multiple-ciphers');
    if (Buffer.from(key).length !== 32) throw new Error('invalid_database_key');
    const connection = new CipherDatabase(filename, { readonly: options.readOnly === true, fileMustExist: options.readOnly === true, timeout: 3000 });
    try {
      connection.key(Buffer.from(key));
      connection.pragma('temp_store=MEMORY');
      connection.pragma('secure_delete=ON');
      connection.prepare('SELECT COUNT(*) FROM sqlite_master').get();
      return connection;
    } catch (error) { connection.close(); throw error; }
  }
}

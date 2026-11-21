import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const MAX_PROFILE_BYTES = 4 * 1024 * 1024;
const nameText = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) ? value.trim().slice(0, 64) : '';

function readProfileFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_PROFILE_BYTES) throw new Error('unreadable_proxy_profile');
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

export function subscriptionFor(candidate) {
  if (!candidate.configPath || !['verge', 'flclash'].includes(candidate.client)) return null;
  const dir = path.dirname(candidate.configPath);
  try {
    const { parse } = require('yaml');
    let id, name, file;
    if (candidate.client === 'verge') {
      const index = parse(readProfileFile(path.join(dir, 'profiles.yaml')));
      const profile = index.items?.find(item => item.uid === index.current && item.type === 'remote');
      if (!profile || !/^[\w.-]+\.ya?ml$/i.test(profile.file)) return null;
      [id, name, file] = [profile.uid, profile.name, profile.file];
    } else {
      const prefs = JSON.parse(readProfileFile(path.join(dir, 'shared_preferences.json')));
      // Dart profile ids may exceed JavaScript's safe integer range.
      const selected = JSON.parse(prefs['flutter.config'], (key, value, context) =>
        key === 'currentProfileId' && typeof value === 'number' ? context.source : value);
      id = String(selected.currentProfileId);
      if (!/^\d{1,19}$/.test(id)) return null;
      const db = new DatabaseSync(path.join(dir, 'database.sqlite'), { readOnly: true });
      try { name = db.prepare("SELECT label FROM profiles WHERE id=? AND type='url'").get(BigInt(id))?.label; }
      finally { db.close(); }
      file = `${id}.yaml`;
    }
    name = nameText(name);
    if (!name) return null;
    const values = parse(readProfileFile(path.join(dir, 'profiles', file)));
    const nodes = new Set(values.proxies?.map(item => item.name).filter(node => typeof node === 'string' && node.length <= 255));
    return nodes.size ? { id, name, nodes } : null;
  } catch { return null; }
}

export function normalizeAirportName(name) {
  return normalizeAirportLabel(name).toLocaleLowerCase('en-US');
}

export function normalizeAirportLabel(name) {
  if (typeof name !== 'string' || /[\x00-\x1f\x7f]/.test(name)) return '';
  return name.normalize('NFKC').trim()
    .replace(/\s*\((?:clash\s*verge|verge|flclash|flclssh|mihomo)\)\s*$/i, '')
    .trim();
}

export function airportGroupKey(name) {
  const key = normalizeAirportName(name);
  return key ? 'airport-' + createHash('sha256').update(key).digest('hex').slice(0, 24) : '';
}

function airport(client, id, name) {
  return { id: 'auto-' + createHash('sha256').update(JSON.stringify([client, id, name])).digest('hex').slice(0, 24), name };
}

export function airportIndex(client, response, subscription) {
  const providers = new Map(), matches = new Map();
  const inventory = response?.providers || {};
  for (const [key, provider] of Object.entries(inventory)) {
    const name = nameText(key);
    if (key === 'default' || !name || provider.vehicleType === 'Compatible' || !Array.isArray(provider.proxies)) continue;
    const entry = { label: airport(client, 'provider:' + key, name), nodes: new Set(provider.proxies.map(item => item.name)) };
    providers.set(key, entry);
    for (const node of entry.nodes) matches.set(node, matches.has(node) ? null : entry.label);
  }
  const inlineNodes = new Set(inventory.default?.proxies?.map(item => item.name));
  const inline = subscription && [...subscription.nodes].every(node => inlineNodes.has(node))
    ? airport(client, 'profile:' + subscription.id, subscription.name) : null;
  return connection => {
    const node = connection.chains?.[0];
    const provider = connection.providerChains?.[0];
    if (!node || /^(DIRECT|REJECT(?:-DROP)?|PASS|COMPATIBLE)$/i.test(node)) return null;
    if (providers.get(provider)?.nodes.has(node)) return providers.get(provider).label;
    if (inline && subscription.nodes.has(node) && !matches.has(node)) return inline;
    // Automatic inference is safe only when exactly one real provider contains
    // the name and it does not also name an inline node.
    return inlineNodes.has(node) ? null : matches.get(node) || null;
  };
}

export function airportProfileStamp(candidate) {
  if (!candidate.configPath) return '';
  const dir = path.dirname(candidate.configPath);
  const files = candidate.client === 'flclash' ? ['config.yaml', 'shared_preferences.json'] : ['clash-verge.yaml', 'profiles.yaml'];
  return files.map(file => {
    try { const stat = fs.statSync(path.join(dir, file)); return `${stat.mtimeMs}/${stat.size}`; }
    catch { return ''; }
  }).join(':');
}

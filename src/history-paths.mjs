import fs from 'node:fs';
import path from 'node:path';

export const HISTORY_LANES = ['windows', 'clash', 'diagnostics'];
export const MIGRATED_HISTORY = 'history-v2';
export const HISTORY_MANIFEST = 'migration.json';

export function historyFilename(lane) {
  return lane === 'diagnostics' ? 'history.sqlite' : 'monitor.sqlite';
}

export function historyDirectory(root, lane, { singleCollector = false } = {}) {
  if (!HISTORY_LANES.includes(lane)) throw new Error('invalid_history_lane');
  if (singleCollector) return root;
  const migrated = path.join(root, MIGRATED_HISTORY);
  if (fs.existsSync(migrated)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(migrated, HISTORY_MANIFEST), 'utf8'));
    if (manifest.version !== 1 || manifest.verified !== true || HISTORY_LANES.some(name =>
      !manifest.lanes?.[name] || !fs.existsSync(path.join(migrated, name, historyFilename(name))))) {
      throw new Error('invalid_history_migration');
    }
    return path.join(migrated, lane);
  }
  if (fs.existsSync(path.join(root, 'vault', 'vault.json'))) throw new Error('history_migration_required');
  return path.join(root, lane);
}

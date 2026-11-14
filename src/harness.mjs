export const DEFAULT_CODEX_PROCESS_NAMES = [
  'codex',
  'codex.exe',
  'codex-code-mode-host.exe',
  'codex-computer-use-swift.exe',
];

export const DEFAULT_HARNESS_APPS = {
  claude: ['claude.exe', 'claude-code.exe', 'claude'],
  dsh: ['dsh.exe', 'dsh-cli.exe', 'dsh'],
};

function cleanNames(value, label) {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`Invalid ${label} process names`);
  const names = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`Invalid ${label} process name`);
    const name = item.trim().split(/[\\/]/).at(-1).toLowerCase();
    if (!name || name.length > 128 || /[\u0000-\u001f]/.test(name))
      throw new Error(`Invalid ${label} process name`);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function normalizeHarnessApps(value, codexNames) {
  const apps = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {
    codex: cleanNames(codexNames ?? apps.codex ?? DEFAULT_CODEX_PROCESS_NAMES, 'Codex'),
    claude: cleanNames(apps.claude ?? DEFAULT_HARNESS_APPS.claude, 'Claude Code'),
    dsh: cleanNames(apps.dsh ?? DEFAULT_HARNESS_APPS.dsh, 'dsh'),
  };
  const owners = new Map();
  for (const [family, names] of Object.entries(result)) {
    for (const name of names) {
      if (family !== 'codex' && ['node.exe','node','python.exe','python','powershell.exe','pwsh.exe','cmd.exe'].includes(name))
        throw new Error('Shared runtimes require a verified script or parent process, not a global name rule');
      const owner = owners.get(name);
      if (owner && owner !== family) throw new Error('A process name cannot belong to two Harness apps');
      owners.set(name, family);
    }
  }
  return result;
}

export function processFamilyMap(apps) {
  return new Map(Object.entries(apps || {}).flatMap(([family, names]) =>
    (Array.isArray(names) ? names : []).map((name) => [String(name).toLowerCase(), family]),
  ));
}

export function familyForProcess(name, families) {
  const base = String(name || '').replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  return families.get(base) || (base ? 'other' : 'unknown');
}

export function isHarnessFamily(value) {
  return ['codex', 'claude', 'dsh'].includes(value);
}

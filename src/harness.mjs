export const DEFAULT_CODEX_PROCESS_NAMES = [
  'codex',
  'codex.exe',
  'codex-code-mode-host.exe',
  'codex-computer-use-swift.exe',
];

export const DEFAULT_HARNESS_APPS = {
  claude: ['claude.exe', 'claude-code.exe', 'claude'],
  dsh: ['dsh.exe', 'dsh-cli.exe', 'dsh'],
  antigravity: ['antigravity.exe', 'antigravity'],
};
export const SCRIPT_HARNESS_FAMILIES = Object.freeze(['codex', 'claude', 'dsh']);
export const HARNESS_FAMILIES = Object.freeze([...SCRIPT_HARNESS_FAMILIES, 'antigravity']);
export const ANTIGRAVITY_BUNDLE_ROOT = 'bundle:antigravity';

export function processImageName(value) {
  return String(value || '').split(/[\\/]/).at(-1);
}

function isLanguageServer(name) {
  return /^language_server(?:_windows_(?:x64|arm64))?(?:\.exe)?$/i.test(name);
}

export function isAntigravityBundleImage(name, executable) {
  const observedName = processImageName(name || executable).toLowerCase();
  if (!executable || !isLanguageServer(observedName)) return false;
  const image = String(executable || '').replaceAll('\\', '/').toLowerCase();
  const imageName = processImageName(image);
  return imageName === `${observedName.replace(/\.exe$/, '')}.exe` && image.endsWith(`/antigravity/resources/bin/${imageName}`);
}

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
  // Respect explicit name assignments already present in older settings.
  const occupied = new Set(Object.values(result).flat());
  const defaults = DEFAULT_HARNESS_APPS.antigravity.filter(name => !occupied.has(name));
  result.antigravity = cleanNames(apps.antigravity ?? defaults, 'Antigravity');
  const owners = new Map();
  for (const [family, names] of Object.entries(result)) {
    for (const name of names) {
      if (family !== 'codex' && ['node.exe','node','python.exe','python','powershell.exe','pwsh.exe','cmd.exe'].includes(name))
        throw new Error('Shared runtimes require a verified script or parent process, not a global name rule');
      if (family === 'antigravity' && isLanguageServer(name))
        throw new Error('Antigravity language servers require the Antigravity installation path or a verified parent');
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
  const base = processImageName(name).toLowerCase();
  return families.get(base) || (base ? 'other' : 'unknown');
}

export function isHarnessFamily(value) {
  return HARNESS_FAMILIES.includes(value);
}

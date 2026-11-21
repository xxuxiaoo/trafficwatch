import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = process.env.TRAFFICWATCH_GIT_EXECUTABLE || 'git';
const trackedOnly = process.argv.includes('--index');
const files = execFileSync(git, ['-c', 'safe.directory=' + root.replaceAll('\\','/'), 'ls-files', '--cached', ...(trackedOnly ? [] : ['--others', '--exclude-standard']), '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
const prohibitedPath = /(?:^|\/)(?:data|work|logs|backups|viewer-cache|runtime|node_modules|\.build)(?:\/|$)|(?:^|\/)(?:handoff\.md|config\.local\.json|suite-settings\.json|\.env(?:\..*)?)$|\.(?:sqlite(?:-.*)?|db(?:-.*)?|csv|tsv|jsonl|log|pcap|pcapng|etl|dmp|dpapi|sealed|pem|key|pfx|exe|dll|zip|nupkg)$/i;
const rules = [
  ['GitHub credential', /(?:github_pat_[a-zA-Z0-9_]{20,}|gh[pousr]_[a-zA-Z0-9]{20,})/],
  ['API credential', /\bsk-[a-zA-Z0-9_-]{24,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];
const problems = [];
for (const relative of [...new Set(files)]) {
  if (prohibitedPath.test(relative)) { problems.push({ file: relative, reason: 'local data or generated artifact' }); continue; }
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep)) throw new Error('Candidate path escaped the source checkout');
  if (!trackedOnly && !fs.existsSync(full)) continue; // A locally removed path cannot enter a commit.
  const stat = fs.lstatSync(full);
  if (!stat.isFile()) { problems.push({ file: relative, reason: 'non-regular file' }); continue; }
  if (stat.size > 2 * 1024 * 1024) { problems.push({ file: relative, reason: 'unexpectedly large source file' }); continue; }
  if (/\.(?:png|ico)$/i.test(relative)) continue;
  const text = fs.readFileSync(full, 'utf8');
  for (const [name, rule] of rules) if (rule.test(text)) problems.push({ file: relative, reason: name });
}
if (problems.length) { console.error(JSON.stringify({ passed: false, problems }, null, 2)); process.exitCode = 1; }
else console.log(JSON.stringify({ passed: true, files: new Set(files).size, checks: ['local data exclusions', 'generated binary exclusions', 'common credential patterns', 'source file sizes'] }, null, 2));

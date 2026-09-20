/**
 * Portable test runner (AIR-06): enumerates test files with the filesystem API instead of
 * relying on shell glob expansion, which Node's test runner does not perform and which
 * shells without globstar/quote handling handle inconsistently. Works identically on
 * Node 20/22/24/26 across macOS/Linux/Windows.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function collect(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && e.name.endsWith('.test.ts')).map((e) => path.join(dir, e.name));
}

const files = [...await collect('test'), ...await collect(path.join('test', 'integration'))].sort();
if (!files.length) { console.error('No test files found'); process.exit(1); }

const result = spawnSync(process.execPath, ['--test', '--import', 'tsx', ...files], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(result.status ?? 1);

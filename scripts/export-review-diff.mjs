#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectDiffExports, exportWorkerDiffs } from './diff-export.mjs';

// Inventory paths once, select once, and read only those diffs. Earlier exports
// never become inputs, even when the evidence directory lives in the worktree.
export async function captureReviewDiff({ cwd, evidence, save }) {
  cwd = await fs.realpath(cwd);
  evidence = path.resolve(evidence);
  await fs.mkdir(evidence, { recursive: true });
  save ??= async (name, value) => fs.writeFile(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const names = (...args) => git(...args).split('\0').filter(Boolean);
  const trackedPaths = [...new Set([...names('ls-files', '-z'), ...names('ls-tree', '-r', '--name-only', '-z', 'HEAD')])];
  const tracked = new Set(trackedPaths);
  const changed = names('diff', 'HEAD', '--name-only', '-z');
  const untracked = names('ls-files', '--others', '--exclude-standard', '-z');
  const changes = { source: 'local_git_path_inventory', files: [...new Set([...changed, ...untracked])].map((path) => ({ path })) };
  const plan = await selectDiffExports({ cwd, evidence, changes, trackedPaths });
  await save('changes.json', changes);
  await save('diff-selection.json', plan);
  const patches = [];
  const maxPatchCharacters = 256 * 1024;
  const call = async (_name, { file }) => {
    let patch;
    try {
      patch = tracked.has(file) ? git('diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', file)
        : git('diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', path.join(cwd, file));
    } catch (error) {
      // A native no-index exit 1 means a difference, not an execution failure.
      if (error.status !== 1 || typeof error.stdout !== 'string') throw error;
      patch = error.stdout;
    }
    const excerpt = patch.slice(0, maxPatchCharacters);
    patches.push(excerpt);
    return { source: 'local_git', files: [{ path: file, diff: excerpt,
      ...(patch.length > maxPatchCharacters ? { truncated: true, fullCharacters: patch.length } : {}) }] };
  };
  const result = await exportWorkerDiffs({ plan, call, save });
  result.limits.maxPatchCharacters = maxPatchCharacters;
  await save('diff.json', result);
  await fs.writeFile(path.join(evidence, 'git.diff'), patches.join('\n'), { flag: 'wx' });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--cwd' || args[2] !== '--evidence') throw new Error('Use --cwd WORKTREE --evidence NEW_DIRECTORY');
  const result = await captureReviewDiff({ cwd: args[1], evidence: args[3] });
  process.stdout.write(JSON.stringify({ files: result.files.length, skipped: result.skipped.length, evidence: path.resolve(args[3]) }) + '\n');
}

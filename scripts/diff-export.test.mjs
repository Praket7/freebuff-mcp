import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectDiffExports, exportWorkerDiffs } from './diff-export.mjs';

test('repeated exports exclude generated evidence and retain tracked and untracked code', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-diff-export-'));
  const evidence = path.join(cwd, 'docs/agent-work/task/worker-next');
  try {
    for (const file of ['src/catalog.rs', 'examples/audit.rs', 'docs/agent-work/task/worker-old/diff-0.json', 'docs/agent-work/task/labels.json']) {
      await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await fs.writeFile(path.join(cwd, file), 'preserve');
    }
    await fs.mkdir(evidence, { recursive: true });
    const changes = { files: ['src/catalog.rs', 'examples/audit.rs', 'docs/agent-work/task/worker-old/diff-0.json', 'docs/agent-work/task/labels.json', 'docs/agent-work/task/worker-next/diff-0.json', '../outside.rs', 'src/catalog.rs'].map((p) => ({ path: p })) };
    const calls = [];
    const call = async (name, args) => { calls.push(args.file); return { files: [{ path: args.file, diff: 'real patch' }] }; };
    const save = (name, value) => fs.writeFile(path.join(evidence, name), JSON.stringify(value));
    const first = await selectDiffExports({ cwd, evidence, changes, trackedPaths: ['src/catalog.rs'] });
    await exportWorkerDiffs({ plan: first, threadId: 'thread', call, save });
    const second = await selectDiffExports({ cwd, evidence, changes, trackedPaths: ['src/catalog.rs'] });
    await exportWorkerDiffs({ plan: second, threadId: 'thread', call, save });
    assert.deepEqual(first.files.map((f) => f.path), ['examples/audit.rs', 'src/catalog.rs']);
    assert.deepEqual(second.files, first.files);
    assert.deepEqual(calls, ['examples/audit.rs', 'src/catalog.rs', 'examples/audit.rs', 'src/catalog.rs']);
    assert.equal(await fs.readFile(path.join(cwd, 'docs/agent-work/task/worker-old/diff-0.json'), 'utf8'), 'preserve');
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('limits, deleted tracked files and generated artifact names have explicit exclusions', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-diff-export-'));
  try {
    await fs.writeFile(path.join(cwd, 'large.rs'), '12345');
    const plan = await selectDiffExports({ cwd, evidence: path.join(cwd, 'evidence'), changes: { files: ['large.rs', 'deleted.rs', 'diff-9.json', 'second-deleted.rs'].map((p) => ({ path: p })) }, trackedPaths: ['large.rs', 'deleted.rs', 'second-deleted.rs'], maxFileBytes: 4, maxFiles: 1 });
    assert.deepEqual(plan.files.map((f) => f.path), ['deleted.rs']);
    assert.deepEqual(plan.skipped.map((f) => f.reason).sort(), ['file_size_limit', 'generated_diff_artifact', 'file_count_limit'].sort());
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('bounded selection is stable under input order and skips tracked exports and private state', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-diff-order-'));
  try {
    const paths = ['z.rs', 'a.rs', 'git.diff', 'diff-0.json', '.freebuff/chat.json', '.env'];
    for (const file of paths) {
      await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await fs.writeFile(path.join(cwd, file), 'fixture');
    }
    const input = { cwd, evidence: path.join(cwd, 'evidence'), trackedPaths: paths, maxFiles: 1 };
    const first = await selectDiffExports({ ...input, changes: { files: paths.map((path) => ({ path })) } });
    const reversed = await selectDiffExports({ ...input, changes: { files: [...paths].reverse().map((path) => ({ path })) } });
    assert.deepEqual(first, reversed);
    assert.deepEqual(first.files.map((file) => file.path), ['a.rs']);
    assert.equal(first.skipped.filter((file) => file.reason === 'generated_diff_artifact').length, 2);
    assert.ok(first.skipped.some((file) => file.reason === 'private_worker_state'));
    assert.ok(first.skipped.some((file) => file.reason === 'private_environment_file'));
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test('a directory link cannot export a file outside the worktree', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-diff-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-diff-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'private.js'), 'outside fixture');
    await fs.symlink(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const plan = await selectDiffExports({ cwd, evidence: path.join(cwd, 'evidence'), changes: { files: [{ path: 'linked/private.js' }] }, trackedPaths: ['linked/private.js'] });
    assert.deepEqual(plan.files, []);
    assert.deepEqual(plan.skipped, [{ path: 'linked/private.js', reason: 'outside_worktree_realpath' }]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

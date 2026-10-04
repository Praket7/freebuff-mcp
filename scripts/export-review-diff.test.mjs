import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { captureReviewDiff } from './export-review-diff.mjs';

test('real Git exports retain code without reading earlier evidence or overwriting a result', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-export-git-'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  try {
    await fs.mkdir(path.join(cwd, 'src'));
    await fs.writeFile(path.join(cwd, 'src/code.js'), 'export const value = 1;\n');
    await fs.writeFile(path.join(cwd, 'src/deleted.js'), 'export const retired = true;\n');
    git('init');
    git('add', 'src/code.js', 'src/deleted.js');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic baseline');
    await fs.writeFile(path.join(cwd, 'src/code.js'), 'export const value = 2;\n');
    await fs.writeFile(path.join(cwd, 'new-code.js'), 'export const added = true;\n');
    git('rm', 'src/deleted.js');
    const old = path.join(cwd, 'docs/agent-work/task/old');
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(path.join(old, 'diff-0.json'), 'DO_NOT_EXPORT'.repeat(100000));
    const firstDir = path.join(cwd, 'docs/agent-work/task/first');
    const secondDir = path.join(cwd, 'docs/agent-work/task/second');
    const first = await captureReviewDiff({ cwd, evidence: firstDir });
    const second = await captureReviewDiff({ cwd, evidence: secondDir });
    assert.deepEqual(first.files.map((f) => f.path), ['new-code.js', 'src/code.js', 'src/deleted.js']);
    assert.deepEqual(second.files, first.files);
    const patch = await fs.readFile(path.join(secondDir, 'git.diff'), 'utf8');
    assert.match(patch, /value = 2/);
    assert.match(patch, /added = true/);
    assert.match(patch, /deleted file mode/);
    assert.match(patch, /-export const retired = true/);
    assert.doesNotMatch(patch, /DO_NOT_EXPORT/);
    assert.equal((await fs.readFile(path.join(old, 'diff-0.json'), 'utf8')).length, 1300000);
    await assert.rejects(captureReviewDiff({ cwd, evidence: secondDir }), { code: 'EEXIST' });
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

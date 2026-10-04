import fs from 'node:fs/promises';
import path from 'node:path';

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

// Evidence is reviewed from its manifest, never by recursively diffing prior
// exports. Preserve a list of every skipped path so exclusions remain visible.
export async function selectDiffExports({ cwd, evidence, changes, trackedPaths, maxFiles = 256, maxFileBytes = 2 * 1024 * 1024 }) {
  const tracked = new Set(trackedPaths.map((file) => file.replaceAll('\\', '/')));
  const files = [];
  const skipped = [];
  const seen = new Set();
  const ordered = [...(changes.files ?? [])].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const entry of ordered) {
    const absolute = path.resolve(cwd, entry.path);
    const relative = path.relative(cwd, absolute).replaceAll('\\', '/');
    let reason;
    if (!inside(cwd, absolute)) reason = 'outside_worktree';
    else if (inside(evidence, absolute)) reason = 'current_evidence_directory';
    else if (/(^|\/)\.astra-freebuff-evidence(\/|$)/.test(relative)) reason = 'generated_evidence_directory';
    else if (/(^|\/)\.freebuff(\/|$)/.test(relative)) reason = 'private_worker_state';
    else if (/(^|\/)\.env($|\.)/.test(relative) && !relative.endsWith('.env.example')) reason = 'private_environment_file';
    else if (!tracked.has(relative) && /^docs\/agent-work\//.test(relative)) reason = 'untracked_agent_work_evidence';
    else if (/(^|\/)(diff-\d+\.json|git\.diff)$/.test(relative)) reason = 'generated_diff_artifact';
    else if (seen.has(relative)) reason = 'duplicate_path';
    else {
      try {
        const stat = await fs.lstat(absolute);
        if (!stat.isFile()) reason = 'non_regular_file';
        else if (stat.size > maxFileBytes) reason = 'file_size_limit';
        else {
          const resolved = await fs.realpath(absolute);
          if (!inside(cwd, resolved)) reason = 'outside_worktree_realpath';
          else if (inside(evidence, resolved)) reason = 'evidence_realpath';
        }
      } catch (error) {
        // Deleted tracked files still need a diff. Other missing paths do not.
        if (error.code !== 'ENOENT' || !tracked.has(relative)) reason = 'unavailable_file';
      }
    }
    if (!reason && files.length >= maxFiles) reason = 'file_count_limit';
    if (reason) skipped.push({ path: entry.path, reason });
    else {
      seen.add(relative);
      files.push({ ...entry, path: relative });
    }
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { files, skipped, limits: { maxFiles, maxFileBytes } };
}

export async function exportWorkerDiffs({ plan, threadId, call, save }) {
  const files = [];
  for (const [index, file] of plan.files.entries()) {
    const artifact = `diff-${index}.json`;
    await save(artifact, await call('get_diff', { threadId, file: file.path, scope: 'uncommitted' }));
    files.push({ path: file.path, artifact });
  }
  return { files, skipped: plan.skipped, limits: plan.limits };
}

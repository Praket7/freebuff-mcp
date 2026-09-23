import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installClaude } from '../src/install/claude.js';
import { claudeConfigPaths } from '../src/install/common.js';
import { HANDOFF_ENV, processIsAlive, readHandoff, writeHandoff } from '../src/desktop/handoff.js';
import { discoverDesktopCandidate, discoverDesktopCandidates, invalidateDiscoveryCache } from '../src/desktop/discovery.js';
import { BridgeError, ErrorCodes, toErrorShape } from '../src/bridge/types.js';

function validHandoff(url = 'http://127.0.0.1:65520') {
  return {
    url,
    launchId: 'hardening-launch-id',
    pid: process.pid,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test('handoff hardening: unknown PID is never treated as alive', () => {
  assert.equal(processIsAlive(undefined), false);
  assert.equal(processIsAlive(0), false);
});

test('handoff hardening: symbolic links are rejected on POSIX', async () => {
  if (process.platform === 'win32') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-handoff-symlink-'));
  const real = path.join(dir, 'real.json');
  const link = path.join(dir, 'handoff.json');
  try {
    await fs.writeFile(real, JSON.stringify({ version: 1, ...validHandoff() }), { encoding: 'utf8', mode: 0o600 });
    await fs.symlink(real, link);
    const result = await readHandoff(link);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'handoff_invalid_file_type');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('handoff hardening: oversized files are rejected before parsing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-handoff-large-'));
  const file = path.join(dir, 'handoff.json');
  try {
    await fs.writeFile(file, Buffer.alloc(64 * 1024 + 1, 0x20), { mode: 0o600 });
    const result = await readHandoff(file);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'handoff_too_large');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('handoff hardening: atomic writer replaces a symlink without touching its target', async () => {
  if (process.platform === 'win32') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-handoff-atomic-'));
  const target = path.join(dir, 'target.txt');
  const handoff = path.join(dir, 'handoff.json');
  try {
    await fs.writeFile(target, 'do-not-touch', 'utf8');
    await fs.symlink(target, handoff);
    await writeHandoff(validHandoff(), handoff);
    assert.equal(await fs.readFile(target, 'utf8'), 'do-not-touch');
    const linkStat = await fs.lstat(handoff);
    assert.equal(linkStat.isSymbolicLink(), false);
    assert.equal((await readHandoff(handoff)).valid, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('discovery hardening: readiness requires a finite fresh timestamp', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-readiness-fresh-'));
  const file = path.join(dir, 'readiness.json');
  const previousReadiness = process.env.FREEBUFF_READINESS_FILE;
  const previousHandoff = process.env[HANDOFF_ENV];
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const url = 'http://127.0.0.1:65521';
  try {
    process.env.FREEBUFF_READINESS_FILE = file;
    process.env[HANDOFF_ENV] = path.join(dir, 'missing-handoff.json');
    delete process.env.FREEBUFF_ORCHESTRATOR_URL;

    await fs.writeFile(file, JSON.stringify({ url, pid: process.pid }), { encoding: 'utf8', mode: 0o600 });
    invalidateDiscoveryCache();
    let result = await discoverDesktopCandidates();
    assert.equal(result.candidates.some((candidate) => candidate.url === url), false, 'missing timestamp rejected');

    await fs.writeFile(file, JSON.stringify({ url, pid: process.pid, timestamp: Date.now() + 120_000 }), { encoding: 'utf8', mode: 0o600 });
    invalidateDiscoveryCache();
    result = await discoverDesktopCandidates();
    assert.equal(result.candidates.some((candidate) => candidate.url === url), false, 'far-future timestamp rejected');
  } finally {
    invalidateDiscoveryCache();
    if (previousReadiness === undefined) delete process.env.FREEBUFF_READINESS_FILE; else process.env.FREEBUFF_READINESS_FILE = previousReadiness;
    if (previousHandoff === undefined) delete process.env[HANDOFF_ENV]; else process.env[HANDOFF_ENV] = previousHandoff;
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('discovery hardening: launch id is sent only to healthz and healthz must answer ok:true', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-discovery-auth-'));
  const file = path.join(dir, 'handoff.json');
  const previousHandoff = process.env[HANDOFF_ENV];
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const originalFetch = globalThis.fetch;
  const url = 'http://127.0.0.1:65522';
  try {
    await writeHandoff(validHandoff(url), file);
    process.env[HANDOFF_ENV] = file;
    delete process.env.FREEBUFF_ORCHESTRATOR_URL;
    const seen: Array<{ url: string; launchId: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      seen.push({ url: requestUrl, launchId: new Headers(init?.headers).get('x-freebuff-launch-id') });
      if (requestUrl.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (requestUrl.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
      throw new Error(`unexpected ${requestUrl}`);
    }) as typeof fetch;
    invalidateDiscoveryCache();
    const candidate = await discoverDesktopCandidate({ force: true });
    assert.equal(candidate?.url, url);
    assert.equal(seen.find((entry) => entry.url.endsWith('/healthz'))?.launchId, 'hardening-launch-id');
    assert.equal(seen.find((entry) => entry.url.endsWith('/api/projects'))?.launchId, null, 'write token not attached to read probe');

    seen.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      seen.push({ url: requestUrl, launchId: new Headers(init?.headers).get('x-freebuff-launch-id') });
      if (requestUrl.endsWith('/healthz')) return new Response(JSON.stringify({ ok: false }), { status: 200 });
      if (requestUrl.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
      throw new Error(`unexpected ${requestUrl}`);
    }) as typeof fetch;
    invalidateDiscoveryCache();
    const readOnlyCandidate = await discoverDesktopCandidate({ force: true });
    assert.equal(readOnlyCandidate?.url, url, 'healthy Desktop remains discoverable after write-auth rejection');
    assert.equal(readOnlyCandidate?.launchId, undefined, 'rejected launch id is stripped so the candidate is read-only');
    assert.equal(seen.some((entry) => entry.url.endsWith('/api/projects')), true, 'read availability is probed after failed write-auth challenge');
    assert.equal(seen.find((entry) => entry.url.endsWith('/api/projects'))?.launchId, null, 'rejected launch id is never sent to the read probe');
  } finally {
    globalThis.fetch = originalFetch;
    invalidateDiscoveryCache();
    if (previousHandoff === undefined) delete process.env[HANDOFF_ENV]; else process.env[HANDOFF_ENV] = previousHandoff;
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('installer hardening: new user config is owner-only on POSIX', async () => {
  if (process.platform === 'win32') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-install-mode-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => dir;
  try {
    const message = await installClaude(true, 'user');
    assert.match(message, /Added the freebuff MCP server/);
    const { user } = claudeConfigPaths();
    assert.equal((await fs.stat(user)).mode & 0o777, 0o600);
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('installer hardening: atomic rewrite preserves an existing config mode', async () => {
  if (process.platform === 'win32') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-install-preserve-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => dir;
  try {
    const { user } = claudeConfigPaths();
    await fs.writeFile(user, JSON.stringify({ theme: 'dark' }), { encoding: 'utf8', mode: 0o640 });
    await fs.chmod(user, 0o640);
    await installClaude(true, 'user');
    assert.equal((await fs.stat(user)).mode & 0o777, 0o640);
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('installer hardening: symlinked config targets are refused on POSIX', async () => {
  if (process.platform === 'win32') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-install-symlink-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => dir;
  const real = path.join(dir, 'real-claude.json');
  try {
    await fs.writeFile(real, JSON.stringify({ theme: 'dark' }), { encoding: 'utf8', mode: 0o600 });
    await fs.symlink(real, path.join(dir, '.claude.json'));
    await assert.rejects(() => installClaude(true, 'user'), /symlinked config/i);
    assert.deepEqual(JSON.parse(await fs.readFile(real, 'utf8')), { theme: 'dark' });
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('discovery hardening: oversized readiness metadata is ignored before JSON parsing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-readiness-large-'));
  const file = path.join(dir, 'readiness.json');
  const previousReadiness = process.env.FREEBUFF_READINESS_FILE;
  const previousHandoff = process.env[HANDOFF_ENV];
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const url = 'http://127.0.0.1:65523';
  try {
    const oversized = JSON.stringify({ url, pid: process.pid, timestamp: Date.now(), pad: 'x'.repeat(70 * 1024) });
    await fs.writeFile(file, oversized, { encoding: 'utf8', mode: 0o600 });
    process.env.FREEBUFF_READINESS_FILE = file;
    process.env[HANDOFF_ENV] = path.join(dir, 'missing-handoff.json');
    delete process.env.FREEBUFF_ORCHESTRATOR_URL;
    invalidateDiscoveryCache();
    const result = await discoverDesktopCandidates();
    assert.equal(result.candidates.some((candidate) => candidate.url === url), false);
  } finally {
    invalidateDiscoveryCache();
    if (previousReadiness === undefined) delete process.env.FREEBUFF_READINESS_FILE; else process.env.FREEBUFF_READINESS_FILE = previousReadiness;
    if (previousHandoff === undefined) delete process.env[HANDOFF_ENV]; else process.env[HANDOFF_ENV] = previousHandoff;
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('discovery hardening: only a bounded tail of large log files is scanned', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-log-tail-'));
  const originalHomedir = os.homedir;
  const previousReadiness = process.env.FREEBUFF_READINESS_FILE;
  const previousHandoff = process.env[HANDOFF_ENV];
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const oldUrl = 'http://127.0.0.1:61001';
  const tailUrl = 'http://127.0.0.1:61002';
  try {
    (os as unknown as { homedir: () => string }).homedir = () => dir;
    const log = path.join(dir, 'Library', 'Application Support', 'Freebuff', 'logs', 'orchestrator-stderr.log');
    await fs.mkdir(path.dirname(log), { recursive: true });
    const prefix = `${oldUrl}\n${'x'.repeat(600 * 1024)}\n`;
    await fs.writeFile(log, `${prefix}${tailUrl}\n`, 'utf8');
    process.env.FREEBUFF_READINESS_FILE = path.join(dir, 'missing-readiness.json');
    process.env[HANDOFF_ENV] = path.join(dir, 'missing-handoff.json');
    delete process.env.FREEBUFF_ORCHESTRATOR_URL;
    invalidateDiscoveryCache();
    const result = await discoverDesktopCandidates();
    assert.equal(result.candidates.some((candidate) => candidate.url === oldUrl), false, 'old URL outside the bounded tail is ignored');
    assert.equal(result.candidates.some((candidate) => candidate.url === tailUrl), true, 'recent URL in the bounded tail is retained');
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    invalidateDiscoveryCache();
    if (previousReadiness === undefined) delete process.env.FREEBUFF_READINESS_FILE; else process.env.FREEBUFF_READINESS_FILE = previousReadiness;
    if (previousHandoff === undefined) delete process.env[HANDOFF_ENV]; else process.env[HANDOFF_ENV] = previousHandoff;
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('CLI hardening: known project roots stay bounded while retaining the default root', async () => {
  const { CliBackend } = await import('../src/backends/cli-backend.js');
  const base = path.join(os.tmpdir(), 'freebuff-root-bound-default');
  const cli = new CliBackend(base);
  try {
    for (let i = 0; i < 150; i++) {
      cli.registerConversationRoot(`conv-${i}`, path.join(os.tmpdir(), `freebuff-root-bound-${i}`));
    }
    const projects = await cli.listProjects() as Array<{ path?: string }>;
    assert.ok(projects.length <= 100, `known roots bounded to 100, got ${projects.length}`);
    assert.ok(projects.some((project) => project.path === base), 'default project root is retained');
  } finally {
    cli.dispose();
  }
});


test('error hardening: structured errors redact secrets from messages and recovery text', () => {
  const generic = toErrorShape(new Error('request failed authorization=super-secret-token'));
  assert.doesNotMatch(generic.message, /super-secret-token/);
  assert.match(generic.message, /REDACTED/);

  const bridge = new BridgeError(
    ErrorCodes.BACKEND_UNAVAILABLE,
    'upstream said Bearer abcdefghijklmnop',
    'retry with api_key=another-secret-value',
  ).toShape();
  assert.doesNotMatch(bridge.message, /abcdefghijklmnop/);
  assert.doesNotMatch(bridge.recovery ?? '', /another-secret-value/);
  assert.match(bridge.message, /REDACTED/);
  assert.match(bridge.recovery ?? '', /REDACTED/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readHandoff, writeHandoff, HANDOFF_ENV } from '../src/desktop/handoff.js';
import { discoverDesktopCandidates, invalidateDiscoveryCache } from '../src/desktop/discovery.js';
import { DesktopBackend } from '../src/backends/desktop-backend.js';

const previousEnv = { ...process.env };

async function inHandoffEnv<T>(handoff: Record<string, unknown> | null, fn: () => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `freebuff-handoff-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  process.env[HANDOFF_ENV] = file;
  if (handoff === null) {
    // leave file missing
  } else if (typeof handoff === 'object' && handoff.__raw) {
    await fs.writeFile(file, String(handoff.__raw), { encoding: 'utf8', mode: 0o600 });
  } else {
    await fs.writeFile(file, JSON.stringify(handoff), { encoding: 'utf8', mode: 0o600 });
  }
  try {
    return await fn();
  } finally {
    delete process.env[HANDOFF_ENV];
    await fs.unlink(file).catch(() => undefined);
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
}

const validHandoff = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  url: 'http://127.0.0.1:55355',
  launchId: 'launch-abc',
  pid: process.pid,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

test('handoff: valid handoff passes validation', async () => {
  await inHandoffEnv(validHandoff(), async () => {
    const result = await readHandoff();
    assert.equal(result.valid, true);
    assert.equal(result.handoff?.launchId, 'launch-abc');
    assert.equal(result.handoff?.pid, process.pid);
  });
});

test('handoff: missing file is rejected', async () => {
  await inHandoffEnv(null, async () => {
    const result = await readHandoff();
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /missing|configured/);
  });
});

test('handoff: malformed JSON is rejected', async () => {
  await inHandoffEnv({ __raw: '{not json' } as unknown as Record<string, unknown>, async () => {
    const result = await readHandoff();
    assert.equal(result.reason, 'handoff_malformed_json');
  });
});

test('handoff: invalid version is rejected', async () => {
  await inHandoffEnv(validHandoff({ version: 99 }), async () => {
    assert.equal((await readHandoff()).reason, 'handoff_unsupported_version');
  });
});

test('handoff: non-loopback URL is rejected', async () => {
  await inHandoffEnv(validHandoff({ url: 'http://10.0.0.5:55355' }), async () => {
    assert.equal((await readHandoff()).reason, 'handoff_non_loopback_url');
  });
});

test('handoff: expired handoff is rejected', async () => {
  await inHandoffEnv(validHandoff({ expiresAt: new Date(Date.now() - 1000).toISOString() }), async () => {
    assert.equal((await readHandoff()).reason, 'handoff_expired');
  });
});

test('handoff: dead PID is rejected', async () => {
  await inHandoffEnv(validHandoff({ pid: 3_999_999_999 }), async () => {
    assert.equal((await readHandoff()).reason, 'handoff_dead_pid');
  });
});

test('handoff: missing launch id or url is rejected', async () => {
  await inHandoffEnv(validHandoff({ launchId: undefined }), async () => {
    assert.equal((await readHandoff()).reason, 'handoff_missing_launch_id');
  });
});

test('discovery: handoff candidate with failing API is not selected', async () => {
  await inHandoffEnv(validHandoff(), async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    try {
      invalidateDiscoveryCache();
      const backend = new DesktopBackend();
      const caps = await backend.probe();
      assert.equal(caps.connection, 'not_running');
    } finally {
      globalThis.fetch = originalFetch;
      invalidateDiscoveryCache();
    }
  });
});

test('discovery: valid handoff with healthy API produces a writable-capable probe', async () => {
  await inHandoffEnv(validHandoff(), async () => {
    const originalFetch = globalThis.fetch;
    const seenLaunchIds: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const launch = new Headers(init?.headers).get('x-freebuff-launch-id');
      if (launch) seenLaunchIds.push(launch);
      if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200 }) as Response;
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true }), { status: 200 }) as Response;
      if (url.endsWith('/api/events')) return new Response(new ReadableStream<Uint8Array>({ start() { /* hold open */ } }), { status: 200 }) as Response;
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    try {
      invalidateDiscoveryCache();
      const backend = new DesktopBackend();
      const caps = await backend.probe();
      assert.equal(caps.connection, 'connected_writable');
      assert.equal(caps.authorization, 'write_authorized');
      assert.ok(seenLaunchIds.includes('launch-abc'), 'launch id from the handoff was used');
      backend.dispose();
    } finally {
      globalThis.fetch = originalFetch;
      invalidateDiscoveryCache();
    }
  });
});

test('discovery: Desktop restart on a new port is recovered via forced rediscovery', async () => {
  await inHandoffEnv(validHandoff({ url: 'http://127.0.0.1:55356' }), async () => {
    const originalFetch = globalThis.fetch;
    let port = 55356;
    let alive = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes(String(port)) || !alive) throw new Error('ECONNREFUSED');
      if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200 }) as Response;
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true }), { status: 200 }) as Response;
      if (url.endsWith('/api/events')) return new Response(new ReadableStream<Uint8Array>({ start() { /* hold open */ } }), { status: 200 }) as Response;
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    try {
      invalidateDiscoveryCache();
      const backend = new DesktopBackend();
      const caps1 = await backend.probe();
      assert.equal(caps1.connection, 'connected_writable');
      // Desktop "restarts" on port 55357 and writes a fresh handoff file.
      port = 55357;
      alive = false;
      const caps2 = await backend.probe();
      assert.equal(caps2.connection, 'not_running');
      alive = true;
      await writeHandoff({ url: `http://127.0.0.1:${port}`, launchId: 'launch-abc', pid: process.pid, expiresAt: new Date(Date.now() + 60_000).toISOString() }, process.env[HANDOFF_ENV]);
      const caps3 = await backend.probe();
      assert.equal(caps3.connection, 'connected_writable', 'recovered after restart');
      backend.dispose();
    } finally {
      globalThis.fetch = originalFetch;
      invalidateDiscoveryCache();
    }
  });
});

test('handoff: writeHandoff round-trips through readHandoff', async () => {
  const file = path.join(os.tmpdir(), `freebuff-write-handoff-${Date.now()}.json`);
  try {
    await writeHandoff({ url: 'http://127.0.0.1:55399', launchId: 'lid', pid: process.pid, expiresAt: new Date(Date.now() + 60_000).toISOString() }, file);
    const result = await readHandoff(file);
    assert.equal(result.valid, true);
    assert.equal(result.handoff?.url, 'http://127.0.0.1:55399');
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
});

test('handoff: written files are owner-only (0600 on POSIX)', async () => {
  const { defaultHandoffPaths } = await import('../src/desktop/handoff.js');
  const file = path.join(os.tmpdir(), `freebuff-perm-handoff-${Date.now()}.json`);
  try {
    await writeHandoff({ url: 'http://127.0.0.1:55398', launchId: 'lid', pid: process.pid, expiresAt: new Date(Date.now() + 60_000).toISOString() }, file);
    if (process.platform !== 'win32') {
      const stat = await fs.stat(file);
      assert.equal(stat.mode & 0o777, 0o600, 'handoff file must be owner-only');
      assert.equal(stat.uid, process.getuid?.(), 'handoff file must be owned by us');
    } else {
      // Windows protects via user-profile ACLs; the producer contract keeps
      // the default inside the current user's profile.
      const profile = process.env.APPDATA ?? process.env.USERPROFILE ?? '';
      assert.ok((defaultHandoffPaths()[0] ?? '').startsWith(profile), 'default handoff lives under the user profile');
    }
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
});


test('handoff: POSIX rejects loose permissions and writeHandoff repairs an existing file to 0600', async () => {
  if (process.platform === 'win32') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-handoff-mode-'));
  const file = path.join(dir, 'mcp-handoff.json');
  try {
    await writeHandoff(validHandoff() as any, file);
    await fs.chmod(file, 0o644);
    const rejected = await readHandoff(file);
    assert.equal(rejected.valid, false);
    assert.equal(rejected.reason, 'handoff_insecure_permissions');

    await writeHandoff(validHandoff({ launchId: 'repaired' }) as any, file);
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
    const accepted = await readHandoff(file);
    assert.equal(accepted.valid, true);
    assert.equal(accepted.handoff?.launchId, 'repaired');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('discovery: readiness metadata without a PID is ignored', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-readiness-pid-'));
  const file = path.join(dir, 'readiness.json');
  const previousReadiness = process.env.FREEBUFF_READINESS_FILE;
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const previousHandoff = process.env[HANDOFF_ENV];
  const missingPidUrl = 'http://127.0.0.1:65432';
  try {
    await fs.writeFile(file, JSON.stringify({ url: missingPidUrl, timestamp: Date.now() }), 'utf8');
    process.env.FREEBUFF_READINESS_FILE = file;
    process.env.FREEBUFF_ORCHESTRATOR_URL = 'http://127.0.0.1:65431';
    process.env[HANDOFF_ENV] = path.join(dir, 'missing-handoff.json');
    invalidateDiscoveryCache();
    const { candidates } = await discoverDesktopCandidates();
    assert.equal(candidates.some((candidate) => candidate.url === missingPidUrl), false);
  } finally {
    invalidateDiscoveryCache();
    if (previousReadiness === undefined) delete process.env.FREEBUFF_READINESS_FILE; else process.env.FREEBUFF_READINESS_FILE = previousReadiness;
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    if (previousHandoff === undefined) delete process.env[HANDOFF_ENV]; else process.env[HANDOFF_ENV] = previousHandoff;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

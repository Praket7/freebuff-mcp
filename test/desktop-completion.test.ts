import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesktopBackend } from '../src/backends/desktop-backend.js';
import { startFakeDesktop } from './helpers/fake-desktop.js';

function withEnv(url: string, launchId: string): () => void {
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  process.env.FREEBUFF_ORCHESTRATOR_URL = url;
  process.env.FREEBUFF_LAUNCH_ID = launchId;
  return () => {
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch;
  };
}

test('desktop: a prompt the Desktop never runs reports waiting, never completed', async () => {
  const desktop = await startFakeDesktop({ neverRunTurn: true });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend({ turnStartGraceMs: 400 });
  try {
    const session = { id: 'bridge-1', backend: 'desktop' as const, backendSessionId: desktop.threadId, cwd: desktop.projectPath };
    const result = await backend.sendMessage({ session, text: 'is anyone there' });
    assert.equal(result.state, 'waiting_for_user', 'an unproven turn must not complete');
    assert.match(String(result.error ?? ''), /did not confirm/i);
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('desktop: an ambiguous prompt submission is never replayed (one logical mutation)', async () => {
  const desktop = await startFakeDesktop({ dropMessageResponse: true });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    const session = { id: 'bridge-1', backend: 'desktop' as const, backendSessionId: desktop.threadId, cwd: desktop.projectPath };
    await assert.rejects(
      () => backend.sendMessage({ session, text: 'commit exactly once' }),
      /NOT retried|unknown whether/i,
      'ambiguity is reported, not hidden behind a replay',
    );
    const commits = desktop.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/message')).length;
    assert.equal(commits, 1, `the prompt reached the Desktop exactly once (saw ${commits})`);
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('desktop: an ambiguous thread creation is never replayed (no duplicate thread)', async () => {
  const desktop = await startFakeDesktop({ dropAfterCommitSuffixes: ['/api/threads'] });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    await assert.rejects(
      () => backend.createSession({ cwd: desktop.projectPath }),
      /NOT retried|unknown whether/i,
      'ambiguity is reported, not hidden behind a replay',
    );
    const created = desktop.calls.filter((c) => c.method === 'POST' && c.path === '/api/threads').length;
    assert.equal(created, 1, `thread creation reached the Desktop exactly once (saw ${created})`);
    const threads = [...desktop.threads.keys()].filter((id) => id.startsWith('created-'));
    assert.equal(threads.length, 1, 'exactly one thread was created');
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('desktop: idempotent control routes retry safely after an ambiguous drop', async () => {
  const desktop = await startFakeDesktop({ dropAfterCommitSuffixes: ['/stop', '/agent'] });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    const session = { id: 'bridge-1', backend: 'desktop' as const, backendSessionId: desktop.threadId, cwd: desktop.projectPath };
    await backend.stop(session);
    const stops = desktop.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/stop')).length;
    assert.equal(stops, 2, `idempotent stop retried once (saw ${stops})`);
    assert.equal(desktop.threads.get(desktop.threadId)?.turnState, 'idle', 'stop took effect');

    await backend.setModel(session, 'fixture-model-2');
    const agents = desktop.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/agent')).length;
    assert.equal(agents, 2, `idempotent setModel retried once (saw ${agents})`);
    assert.equal(desktop.threads.get(desktop.threadId)?.model, 'fixture-model-2', 'model applied exactly');
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('desktop: /resume and /effort replay-safe after an ambiguous drop', async () => {
  const desktop = await startFakeDesktop({ dropAfterCommitSuffixes: ['/resume', '/effort'] });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    const session = { id: 'bridge-1', backend: 'desktop' as const, backendSessionId: desktop.threadId, cwd: desktop.projectPath };
    await backend.resume(session);
    const resumes = desktop.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/resume')).length;
    assert.equal(resumes, 2, `idempotent resume retried once (saw ${resumes})`);

    await backend.setReasoning(session, 'high');
    const efforts = desktop.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/effort')).length;
    assert.equal(efforts, 2, `idempotent effort retried once (saw ${efforts})`);
    assert.equal(desktop.threads.get(desktop.threadId)?.reasoning, 'high', 'reasoning applied exactly once');
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('desktop: a real turn still completes with finish-timestamp proof', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 30 });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    const session = { id: 'bridge-1', backend: 'desktop' as const, backendSessionId: desktop.threadId, cwd: desktop.projectPath };
    const result = await backend.sendMessage({ session, text: 'quick job' });
    assert.equal(result.state, 'completed');
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('desktop: SSE failures on a dead port trigger rediscovery onto the new port', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-redisc-home-'));
  const previousHome = process.env.HOME;
  const previousHandoff = process.env.FREEBUFF_MCP_HANDOFF_FILE;
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  const originalHomedir = os.homedir;
  const originalFetch = globalThis.fetch;
  process.env.HOME = home;
  (os as unknown as { homedir: () => string }).homedir = () => home;
  delete process.env.FREEBUFF_ORCHESTRATOR_URL;
  delete process.env.FREEBUFF_LAUNCH_ID;
  const handoffFile = path.join(home, 'handoff.json');
  process.env.FREEBUFF_MCP_HANDOFF_FILE = handoffFile;
  const URL1 = 'http://127.0.0.1:55971';
  const URL2 = 'http://127.0.0.1:55972';
  const eventsHits: string[] = [];
  const threadPayload = (id: string) => ({ thread: { id, turnState: 'idle' }, messages: [], items: [] });
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.startsWith(URL1) && url.endsWith('/api/events')) throw new Error('ECONNREFUSED');
    if (url.startsWith(URL2) && url.endsWith('/api/events')) {
      eventsHits.push(url);
      return new Response(new ReadableStream<Uint8Array>({ start() { /* hold */ } }), { status: 200 }) as Response;
    }
    if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200 }) as Response;
    if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true }), { status: 200 }) as Response;
    if (/\/api\/thread\/[^/]+$/.test(url)) return new Response(JSON.stringify(threadPayload('t')), { status: 200 }) as Response;
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const writeHandoff = (url: string) => fs.writeFile(
    handoffFile,
    JSON.stringify({ version: 1, url, launchId: 'lid', pid: process.pid, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    { encoding: 'utf8', mode: 0o600 },
  );
  const { invalidateDiscoveryCache } = await import('../src/desktop/discovery.js');
  try {
    invalidateDiscoveryCache();
    await writeHandoff(URL1);
    const backend = new DesktopBackend({ streamFailureThreshold: 2 });
    const caps = await backend.probe();
    assert.equal(caps.connection, 'connected_writable', 'initial link is on the old port');
    await writeHandoff(URL2);
    const deadline = Date.now() + 10_000;
    while (eventsHits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(eventsHits.length > 0, 'the stream was rediscovered onto the new port');
    backend.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousHandoff === undefined) delete process.env.FREEBUFF_MCP_HANDOFF_FILE; else process.env.FREEBUFF_MCP_HANDOFF_FILE = previousHandoff;
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch;
    await fs.rm(home, { recursive: true, force: true });
    invalidateDiscoveryCache();
  }
});

test('handoff: platform-default locations are discovered with no env configured', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-handoff-home-'));
  const previousHome = process.env.HOME;
  const previousEnv = process.env.FREEBUFF_MCP_HANDOFF_FILE;
  const originalHomedir = os.homedir;
  process.env.HOME = home;
  delete process.env.FREEBUFF_MCP_HANDOFF_FILE;
  (os as unknown as { homedir: () => string }).homedir = () => home;
  try {
    const { readHandoff, defaultHandoffPaths } = await import('../src/desktop/handoff.js');
    const target = defaultHandoffPaths()[0];
    assert.ok(target, 'this platform has a default handoff path');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      JSON.stringify({ version: 1, url: 'http://127.0.0.1:55991', launchId: 'lid', pid: process.pid, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      { encoding: 'utf8', mode: 0o600 },
    );
    const result = await readHandoff();
    assert.equal(result.valid, true, `default handoff discovered: ${result.reason ?? ''}`);
    assert.equal(result.handoff?.launchId, 'lid');
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousEnv === undefined) delete process.env.FREEBUFF_MCP_HANDOFF_FILE; else process.env.FREEBUFF_MCP_HANDOFF_FILE = previousEnv;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('discovery: non-loopback explicit and readiness URLs are never fetched', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-disc-home-'));
  const previousHome = process.env.HOME;
  const previousUrl = process.env.FREEBUFF_ORCHESTRATOR_URL;
  const previousHandoff = process.env.FREEBUFF_MCP_HANDOFF_FILE;
  const previousReadiness = process.env.FREEBUFF_READINESS_FILE;
  const originalHomedir = os.homedir;
  const originalFetch = globalThis.fetch;
  process.env.HOME = home;
  (os as unknown as { homedir: () => string }).homedir = () => home;
  process.env.FREEBUFF_ORCHESTRATOR_URL = 'http://10.0.0.5:9999';
  process.env.FREEBUFF_MCP_HANDOFF_FILE = path.join(home, 'missing.json');
  const readiness = path.join(home, 'readiness.json');
  await fs.writeFile(readiness, JSON.stringify({ url: 'http://10.0.0.5:9998', launchId: 'x', pid: process.pid, timestamp: Date.now() }), 'utf8');
  process.env.FREEBUFF_READINESS_FILE = readiness;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    fetched.push(String(input));
    throw new Error('must stay hermetic');
  }) as typeof fetch;
  try {
    const { discoverDesktopCandidates, invalidateDiscoveryCache } = await import('../src/desktop/discovery.js');
    invalidateDiscoveryCache();
    const { candidates } = await discoverDesktopCandidates();
    assert.ok(candidates.every((c) => c.source !== 'explicit'), 'non-loopback explicit URL rejected');
    assert.ok(!fetched.some((u) => u.includes('10.0.0.5')), `no request to 10.0.0.5: ${fetched.join(',')}`);
  } finally {
    globalThis.fetch = originalFetch;
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUrl === undefined) delete process.env.FREEBUFF_ORCHESTRATOR_URL; else process.env.FREEBUFF_ORCHESTRATOR_URL = previousUrl;
    if (previousHandoff === undefined) delete process.env.FREEBUFF_MCP_HANDOFF_FILE; else process.env.FREEBUFF_MCP_HANDOFF_FILE = previousHandoff;
    if (previousReadiness === undefined) delete process.env.FREEBUFF_READINESS_FILE; else process.env.FREEBUFF_READINESS_FILE = previousReadiness;
    await fs.rm(home, { recursive: true, force: true });
    const { invalidateDiscoveryCache } = await import('../src/desktop/discovery.js');
    invalidateDiscoveryCache();
  }
});

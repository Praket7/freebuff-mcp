import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopBackend } from '../src/backends/desktop-backend.js';
import { CompositeBackend } from '../src/backends/backend.js';
import { SessionManager } from '../src/bridge/session-manager.js';
import { TurnManager } from '../src/bridge/turn-manager.js';
import { startFakeDesktop } from './helpers/fake-desktop.js';

/**
 * Integration tests that talk real HTTP to a fake orchestrator serving the REAL
 * Desktop contract. Unlike the `fetch`-stubbed tests, these exercise sockets,
 * the SSE client, status codes, and payload wrappers end to end.
 */
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

test('http: probe, thread listing, thread read, and changes work over real sockets', async () => {
  const desktop = await startFakeDesktop();
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    const caps = await backend.probe();
    assert.equal(caps.connection, 'connected_writable');
    assert.equal(caps.authorization, 'write_authorized');

    const threads = (await backend.listThreads()) as Array<Record<string, unknown>>;
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.id, desktop.threadId);

    const thread = (await backend.getThread(desktop.threadId)) as Record<string, unknown>;
    assert.equal(thread.title, 'Fixture thread');
    assert.equal((thread.messages as unknown[]).length, 2);

    const attachments = (await backend.listAttachments(desktop.threadId)) as unknown[];
    assert.equal(attachments.length, 1, 'attachments come from messages');

    desktop.setChangedFiles(desktop.threadId, [{ path: 'src/a.ts', adds: 3, dels: 1 }]);
    const changes = (await backend.getChanges(desktop.threadId, 'all')) as Record<string, unknown>;
    assert.deepEqual(changes.totals, { files: 1, adds: 3, dels: 1 });
    const diff = (await backend.getDiff(desktop.threadId, 'src/a.ts', 'all')) as Record<string, unknown>;
    assert.match(String(diff.patch), /^diff --git a\/src\/a\.ts/);
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('http: createSession posts to /api/threads and the new thread is readable', async () => {
  const desktop = await startFakeDesktop();
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    const session = await backend.createSession!({ cwd: desktop.projectPath });
    assert.ok(session.backendSessionId);
    const created = (await backend.getThread(String(session.backendSessionId))) as Record<string, unknown>;
    assert.equal(created.id, session.backendSessionId);
    assert.equal(created.title, 'New thread');
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('http: sendMessage WAITS for the turn to finish instead of reporting completed immediately', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 400 });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    const session = { id: 'bridge-1', backend: 'desktop' as const, backendSessionId: desktop.threadId, cwd: desktop.projectPath };
    const events: string[] = [];
    const started = Date.now();
    const result = await backend.sendMessage({ session, text: 'please work', onEvent: (event) => { events.push(`${event.type}:${event.state ?? ''}`); } });
    const elapsed = Date.now() - started;
    assert.equal(result.state, 'completed', `expected completion, got ${result.state}`);
    assert.ok(elapsed >= 350, `sendMessage waited for the turn (${elapsed}ms)`);
    // The Desktop exposed `running` then `idle`; the bridge saw them via SSE.
    assert.ok(events.some((e) => e.includes('running')), `saw a running event: ${events.join(', ')}`);
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('http: a failed turn is reported as failed, not completed', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 20, failTurn: true });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    const session = { id: 'bridge-1', backend: 'desktop' as const, backendSessionId: desktop.threadId, cwd: desktop.projectPath };
    const result = await backend.sendMessage({ session, text: 'break please' });
    assert.equal(result.state, 'failed');
    assert.match(String(result.error), /error outcome/i);
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('http: cancelling a running turn aborts it and reports cancelled', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 5_000 });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new DesktopBackend();
  try {
    const session = { id: 'bridge-1', backend: 'desktop' as const, backendSessionId: desktop.threadId, cwd: desktop.projectPath };
    const controller = new AbortController();
    const pending = backend.sendMessage({ session, text: 'long job', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const result = await pending;
    assert.equal(result.state, 'cancelled');
  } finally {
    backend.dispose();
    restoreEnv();
    await desktop.close();
  }
});

test('http: run_turn over the canonical bridge waits for the real turn and maps identity', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 250 });
  const restoreEnv = withEnv(desktop.url, desktop.launchId);
  const backend = new CompositeBackend();
  const sessions = new SessionManager(backend);
  const turns = new TurnManager(sessions);
  try {
    const session = await sessions.createSession({ cwd: desktop.projectPath });
    assert.notEqual(session.id, session.backendSessionId, 'bridge id differs from the Desktop thread id');
    const turn = await turns.startTurn(session.id, { text: 'run the real thing' });
    assert.equal(turn.state, 'completed');
    // The Desktop received the prompt on the real action route, addressed to the
    // thread it created for this session (never a bridge-generated id).
    assert.ok(
      desktop.calls.some((c) => c.method === 'POST' && c.path === `/api/thread/${session.backendSessionId}/message`),
      `expected a POST to /api/thread/${session.backendSessionId}/message, saw: ${desktop.calls.map((c) => `${c.method} ${c.path}`).join(', ')}`,
    );
    // The canonical store must reflect the REAL stream's health: a healthy
    // Desktop must never be reported as disconnected/stale mid-turn.
    const snapshot = sessions.events.progress(session.backendSessionId!, 0, 5);
    assert.equal(snapshot.connected, true, 'live stream health reaches the canonical event store');
    assert.equal(snapshot.stale, false, 'fresh progress is not stale');
    assert.ok(snapshot.events.length > 0, 'progress events were captured for the real thread');
  } finally {
    sessions.dispose();
    restoreEnv();
    await desktop.close();
  }
});

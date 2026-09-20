import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CompositeBackend } from '../src/backends/backend.js';
import { SessionManager } from '../src/bridge/session-manager.js';
import { BackendCapabilities, FreebuffBackend } from '../src/bridge/types.js';
import { createV2ServerFromAdapter, V2Adapter } from '../src/mcp-v2.js';
import { TurnManager } from '../src/bridge/turn-manager.js';
import { EventStore } from '../src/bridge/event-store.js';

/** Backend whose stop always fails: cancellation must say so loudly. */
function failingStopBackend(): FreebuffBackend {
  return {
    kind: 'desktop',
    probe: async () => ({ backend: 'desktop', connection: 'connected_writable', authorization: 'write_authorized', liveProgress: 'connected', canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    createSession: async ({ cwd }: { cwd: string }) => ({ id: 'h1', backend: 'desktop' as const, backendSessionId: 'thread-1', cwd }),
    sendMessage: async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { state: 'completed' as const, result: {} };
    },
    stop: async () => { throw new Error('stop denied by fixture'); },
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
}

test('cancellation: a failed backend stop is reported, never implied', async () => {
  const manager = new SessionManager(failingStopBackend());
  const session = await manager.createSession({ cwd: '/tmp/p' });
  const handle = manager.startTurn(session.id, { text: 'work' });
  await new Promise((r) => setTimeout(r, 10));
  const outcome = await manager.cancelTurn(session.id, handle.turn.id);
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.stopped, false);
  assert.match(outcome.stopError ?? '', /stop denied/);
  const turn = await handle.done;
  assert.equal(turn.state, 'cancelled');
  assert.match(turn.error ?? '', /may still be running/);
});

function desktopStubWithStream(connection: 'connected_writable' | 'connected_read_only' | 'not_running', calls: string[]): FreebuffBackend {
  const writable = connection === 'connected_writable';
  return {
    kind: 'desktop',
    probe: async () => ({
      backend: 'desktop', connection, authorization: writable ? 'write_authorized' : connection === 'connected_read_only' ? 'read_only' : 'none',
      liveProgress: 'connected', canCreateSession: writable, canSendMessage: writable, canStop: writable,
      canResume: writable, canSetModel: writable, canSetReasoning: writable, notes: [],
    }),
    onStreamHealth: (listener: (h: { connected: boolean }) => void) => { listener({ connected: true }); return () => undefined; },
    createSession: async ({ cwd }: { cwd: string }) => ({ id: 'd1', backend: 'desktop' as const, backendSessionId: 'd1', cwd }),
    sendMessage: async () => ({ state: 'completed' as const, result: {} }),
    listProjects: async () => [],
    listThreads: async () => [],
    getThread: async (id: string) => ({ id }),
    getMessages: async () => [],
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
}

function cliStubWithModel(calls: string[]): FreebuffBackend {
  return {
    kind: 'cli',
    probe: async () => ({ backend: 'cli', connection: 'cli_ready', authorization: 'write_authorized', liveProgress: 'unavailable', canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    createSession: async ({ cwd }: { cwd: string }) => ({ id: 'c1', backend: 'cli' as const, backendSessionId: 'conv-c1', cwd }),
    sendMessage: async ({ session, text }: { session: { id: string }; text: string }) => { calls.push(`send:${session.id}:${text}`); return { state: 'completed' as const, result: {} }; },
    setModel: async (session: { id: string }, model: string) => { calls.push(`setModel:${session.id}:${model}`); return { model }; },
    setReasoning: async (session: { id: string }, effort: string | null) => { calls.push(`setReasoning:${session.id}:${effort}`); return { effort }; },
    listProjects: async () => [],
    listThreads: async () => [],
    getThread: async (id: string) => ({ id }),
    getMessages: async () => [],
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
}

async function withCliBinary<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-cli-bin-'));
  const bin = path.join(dir, 'freebuff');
  await fs.writeFile(bin, '#!/bin/sh\nexit 0\n');
  await fs.chmod(bin, 0o755);
  const previous = process.env.FREEBUFF_CLI_PATH;
  process.env.FREEBUFF_CLI_PATH = bin;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FREEBUFF_CLI_PATH; else process.env.FREEBUFF_CLI_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const ctx = { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => undefined } };

function toolOf(server: unknown, name: string): { handler: (args: unknown, ctx: unknown) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }> } {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, ctx: unknown) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }> }> })._registeredTools;
  const tool = tools[name];
  assert.ok(tool, `${name} registered`);
  return tool!;
}

test('liveness: automatic CLI fallback is live only while its turn runs', async () => {
  await withCliBinary(async () => {
    const composite = new CompositeBackend({ desktop: desktopStubWithStream('connected_read_only', []) as never, cli: cliStubWithModel([]) as never });
    const sessions = new SessionManager(composite);
    // Read-only Desktop + available CLI: creation routes to the CLI.
    const session = await sessions.createSession({ cwd: '/tmp/p' });
    assert.equal(session.backend, 'cli');
    const thread = session.backendSessionId ?? session.id;
    const handle = sessions.startTurn(session.id, { text: 'work' });
    assert.equal(sessions.events.progress(thread, 0, 1).connected, true, 'live while the CLI turn runs');
    await handle.done;
    // The Desktop stream is healthy globally, but that says nothing about the
    // CLI thread: it must report not-live now.
    assert.equal(sessions.events.progress(thread, 0, 1).connected, false, 'not live once the CLI turn ends');
  });
});

test('set_model: a CLI-owned session bypasses read-only Desktop capability gates', async () => {
  await withCliBinary(async () => {
    const desktopCalls: string[] = [];
    const cliCalls: string[] = [];
    const composite = new CompositeBackend({ desktop: desktopStubWithStream('connected_read_only', desktopCalls) as never, cli: cliStubWithModel(cliCalls) as never });
    const sessions = new SessionManager(composite);
    const turns = new TurnManager(sessions);
    const adapter: V2Adapter = { backend: composite, sessions, turns };
    const server = createV2ServerFromAdapter(adapter);
    const session = await sessions.createSession({ cwd: '/tmp/p' });
    assert.equal(session.backend, 'cli');
    const out = await toolOf(server, 'set_model').handler({ threadId: session.backendSessionId, model: 'm' }, ctx);
    assert.equal(out.structuredContent?.ok, true);
    assert.ok(cliCalls.some((c) => c === 'setModel:c1:m'), `CLI owner received setModel: ${cliCalls.join(',')}`);
    assert.deepEqual(desktopCalls, [], 'the read-only Desktop was not consulted');
  });
});

test('resume_thread: a bare CLI conversation id resumes on the CLI, not the Desktop', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-cli-home-'));
  const previousHome = process.env.HOME;
  const previousRoot = process.env.FREEBUFF_PROJECT_ROOT;
  const originalHomedir = os.homedir;
  process.env.HOME = home;
  (os as unknown as { homedir: () => string }).homedir = () => home;
  try {
    const cwd = path.join(home, 'proj');
    await fs.mkdir(cwd, { recursive: true });
    process.env.FREEBUFF_PROJECT_ROOT = cwd;
    const key = `${path.basename(cwd)}--${createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12)}`;
    const dir = path.join(home, '.config', 'manicode', 'projects', key, 'chats', 'cli-resume-9');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'log.jsonl'), '{"role":"user"}\n', 'utf8');
    await fs.writeFile(path.join(dir, 'chat-meta.json'), '{}', 'utf8');

    const cliCalls: string[] = [];
    const composite = new CompositeBackend({ desktop: desktopStubWithStream('connected_writable', []) as never, cli: cliStubWithModel(cliCalls) as never });
    const sessions = new SessionManager(composite);
    const adapter: V2Adapter = { backend: composite, sessions, turns: new TurnManager(sessions) };
    const server = createV2ServerFromAdapter(adapter);
    const out = await toolOf(server, 'resume_thread').handler({ threadId: 'cli-resume-9' }, ctx);
    assert.equal(out.structuredContent?.ok, true);
    assert.ok(cliCalls.some((c) => c === 'send:cli-resume-9:/resume'), `CLI owner received /resume: ${cliCalls.join(',')}`);
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousRoot === undefined) delete process.env.FREEBUFF_PROJECT_ROOT; else process.env.FREEBUFF_PROJECT_ROOT = previousRoot;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('mcp errors: tool failures are marked isError for MCP clients', async () => {
  const backend = {
    kind: 'desktop' as const,
    probe: async () => ({ backend: 'desktop' as const, connection: 'unavailable' as const, authorization: 'none' as const, liveProgress: 'unavailable' as const, canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: [] }),
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const adapter: V2Adapter = { backend, sessions, turns: new TurnManager(sessions) };
  const server = createV2ServerFromAdapter(adapter);
  const out = await toolOf(server, 'get_changes').handler({ threadId: 'thread-1' }, undefined);
  assert.equal(out.structuredContent?.ok, false);
  assert.equal(out.isError, true, 'model-visible failures carry isError:true');
});

test('list_models: never calls getThread with an empty id', async () => {
  let getThreadCalled = false;
  const backend = {
    kind: 'desktop' as const,
    probe: async () => ({ backend: 'desktop' as const, connection: 'connected_writable' as const, authorization: 'write_authorized' as const, liveProgress: 'connected' as const, canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    getThread: async () => { getThreadCalled = true; throw new Error('must not be called'); },
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const adapter: V2Adapter = { backend, sessions, turns: new TurnManager(sessions) };
  const server = createV2ServerFromAdapter(adapter);
  const out = await toolOf(server, 'list_models').handler({}, undefined);
  assert.equal(out.structuredContent?.ok, true);
  assert.equal(out.structuredContent?.catalogAvailable, false);
  assert.equal(getThreadCalled, false, 'no empty-id getThread call');
});

test('event store: invalid timestamps are normalized instead of poisoning staleness', () => {
  const store = new EventStore();
  const event = store.append({ sessionId: 's', turnId: 't', threadId: 'th', type: 'phase', timestamp: 'not-a-time' });
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)), 'stored timestamp parses');
  const snapshot = store.progress('th', 0, 1);
  assert.ok(typeof snapshot.secondsSinceLastEvent === 'number' && Number.isFinite(snapshot.secondsSinceLastEvent), 'staleness math stays finite');
});

test('sessions: old terminal turns are pruned so processes stay bounded', async () => {
  const backend = {
    kind: 'desktop' as const,
    probe: async () => ({}),
    createSession: (() => { let n = 0; return async ({ cwd }: { cwd: string }) => { n += 1; return { id: `h${n}`, backend: 'desktop' as const, backendSessionId: `t${n}`, cwd }; }; })(),
    sendMessage: async () => ({ state: 'completed' as const, result: {} }),
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
  const manager = new SessionManager(backend);
  const firstIds: string[] = [];
  let lastTurnId = '';
  for (let i = 0; i < 600; i++) {
    const session = await manager.createSession({ cwd: '/tmp/p' });
    const handle = manager.startTurn(session.id, { text: `turn ${i}` });
    if (i === 0) firstIds.push(handle.turn.id);
    lastTurnId = handle.turn.id;
    await handle.done;
  }
  assert.throws(() => new TurnManager(manager).getTurn(firstIds[0]!), /Unknown bridge turn/, 'the oldest terminal turn was pruned');
  assert.ok(new TurnManager(manager).getTurn(lastTurnId), 'the newest turn is retained');
});

test('capabilities: BackendCapabilities covers CLI states without conflation', async () => {
  const { CliBackend } = await import('../src/backends/cli-backend.js');
  const caps = await new CliBackend('/tmp/definitely-not-a-project').probe();
  // The two states must never conflate: a missing binary is not_installed
  // (never "not authenticated"), and a present binary is cli_ready.
  assert.ok(['cli_ready', 'not_installed'].includes(caps.connection), `got ${caps.connection}`);
  assert.ok(!['cli_not_authenticated', 'cli_not_installed'].includes(caps.connection), 'no invented connection states');
  if (caps.connection === 'not_installed') {
    assert.equal(caps.authorization, 'none');
    assert.equal(caps.canSendMessage, false);
  } else {
    assert.equal(caps.canSendMessage, true);
    assert.equal(caps.authorization, 'unknown', 'a binary alone never proves login');
  }
});

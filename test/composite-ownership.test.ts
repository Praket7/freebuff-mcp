import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompositeBackend } from '../src/backends/backend.js';
import { SessionManager } from '../src/bridge/session-manager.js';
import { TurnManager } from '../src/bridge/turn-manager.js';
import { BackendCapabilities, FreebuffBackend } from '../src/bridge/types.js';

/**
 * P0-01 / P0-02 / P1-08 regression tests: backend ownership and routing.
 *
 * The bridge session must record the CONCRETE owner (kind + exact handle the
 * backend returned), never the composite facade's default kind or a
 * bridge-generated UUID. Session creation must route by operation: a read-only
 * Desktop cannot create threads or take writes, so those fall through to the
 * CLI. Aggregate reads must route to whichever backend can serve them.
 */

interface DesktopStubOptions {
  connection: 'connected_writable' | 'connected_read_only' | 'not_running';
  calls: string[];
}

function desktopStub(options: DesktopStubOptions): FreebuffBackend {
  const writable = options.connection === 'connected_writable';
  const caps: BackendCapabilities = {
    backend: 'desktop',
    connection: options.connection,
    authorization: writable ? 'write_authorized' : options.connection === 'connected_read_only' ? 'read_only' : 'none',
    liveProgress: options.connection === 'not_running' ? 'unavailable' : 'connected',
    canCreateSession: writable,
    canSendMessage: writable,
    canStop: writable,
    canResume: writable,
    canSetModel: writable,
    canSetReasoning: writable,
    notes: [`desktop ${options.connection}`],
  };
  return {
    kind: 'desktop',
    probe: async () => caps,
    createSession: async ({ cwd }: { cwd: string }) => {
      options.calls.push('desktop.createSession');
      return { id: 'desktop-thread-1', backend: 'desktop', backendSessionId: 'desktop-thread-1', cwd };
    },
    sendMessage: async () => { options.calls.push('desktop.sendMessage'); return { state: 'completed', result: {} }; },
    listProjects: async () => [{ id: 'dproj', path: 'dproj' }],
    listThreads: async () => [{ id: 'desktop-thread-1', turnState: 'idle', projectId: 'dproj' }],
    getThread: async () => ({ id: 'desktop-thread-1', title: 'Desktop thread', turnState: 'idle' }),
    getMessages: async () => [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    dispose: () => undefined,
  } as FreebuffBackend;
}

interface CliStubCalls { create: Array<{ id: string }>; send: Array<{ id: string; text: string }>; read: string[] }

function cliStub(calls: CliStubCalls): FreebuffBackend & { calls: CliStubCalls } {
  let counter = 0;
  return {
    kind: 'cli',
    calls,
    probe: async () => ({ backend: 'cli', connection: 'cli_ready', authorization: 'write_authorized', liveProgress: 'unavailable', canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: ['cli stub'] }),
    createSession: async ({ cwd }: { cwd: string }) => {
      counter += 1;
      const id = `cli-session-${counter}`;
      calls.create.push({ id });
      return { id, backend: 'cli', backendSessionId: `conv-${id}`, cwd };
    },
    sendMessage: async ({ session, text }: { session: { id: string }; text: string }) => {
      if (!calls.create.some((c) => c.id === session.id)) calls.create.push({ id: session.id });
      calls.send.push({ id: session.id, text });
      return { state: 'completed', result: { ok: true } };
    },
    listProjects: async () => [{ id: '/tmp/p', path: '/tmp/p', name: 'p' }],
    listThreads: async () => [{ id: 'cli-conv-1', firstPrompt: 'hello', messageCount: 3 }],
    getThread: async (id: string) => { calls.read.push(`getThread:${id}`); return { id, title: 'CLI conversation', turnState: 'idle' }; },
    getMessages: async (id: string) => { calls.read.push(`getMessages:${id}`); return [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]; },
    dispose: () => undefined,
  } as unknown as FreebuffBackend & { calls: CliStubCalls };
}

/** Make `findFreebuffCli` resolve hermetically so the CLI is "available". */
async function withCliBinary(run: () => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-cli-bin-'));
  const bin = path.join(dir, 'freebuff');
  await fs.writeFile(bin, '#!/bin/sh\nexit 0\n');
  await fs.chmod(bin, 0o755);
  const previous = process.env.FREEBUFF_CLI_PATH;
  process.env.FREEBUFF_CLI_PATH = bin;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.FREEBUFF_CLI_PATH; else process.env.FREEBUFF_CLI_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('ownership: with no Desktop, sessions are created on the CLI and turns route through the CLI handle', async () => {
  await withCliBinary(async () => {
    const desktopCalls: string[] = [];
    const cliCalls: CliStubCalls = { create: [], send: [], read: [] };
    const composite = new CompositeBackend({ desktop: desktopStub({ connection: 'not_running', calls: desktopCalls }) as never, cli: cliStub(cliCalls) as never });
    const sessions = new SessionManager(composite);

    const session = await sessions.createSession({ cwd: '/tmp/p' });
    // P0-01: the bridge session records the CONCRETE owner and its exact handle.
    assert.equal(session.backend, 'cli', 'the CLI owns the session, not the composite default');
    assert.equal(session.backendHandleId, 'cli-session-1', 'backendHandleId is the CLI backend handle');
    assert.notEqual(session.id, session.backendHandleId, 'bridge id never collides with the backend handle');
    assert.match(session.backendSessionId ?? '', /^conv-cli-session-/);

    const handle = sessions.startTurn(session.id, { text: 'do the thing' });
    const turn = await handle.done;
    assert.equal(turn.state, 'completed');
    // The prompt went to the CLI with the CLI's own handle — never to the Desktop.
    assert.deepEqual(cliCalls.send, [{ id: 'cli-session-1', text: 'do the thing' }]);
    assert.deepEqual(desktopCalls, [], 'the Desktop was never touched');
  });
});

test('ownership: a read-only Desktop routes session creation (a write) to the CLI', async () => {
  await withCliBinary(async () => {
    const desktopCalls: string[] = [];
    const cliCalls: CliStubCalls = { create: [], send: [], read: [] };
    const composite = new CompositeBackend({ desktop: desktopStub({ connection: 'connected_read_only', calls: desktopCalls }) as never, cli: cliStub(cliCalls) as never });
    const sessions = new SessionManager(composite);

    const session = await sessions.createSession({ cwd: '/tmp/p' });
    assert.equal(session.backend, 'cli', 'creating a thread is a write, so the CLI must own it');
    assert.equal(session.backendHandleId, 'cli-session-1');
    assert.deepEqual(desktopCalls, [], 'the read-only Desktop was not asked to create a thread');
  });
});

test('ownership: a writable Desktop stays the primary Session creator when a CLI is also present', async () => {
  await withCliBinary(async () => {
    const desktopCalls: string[] = [];
    const cliCalls: CliStubCalls = { create: [], send: [], read: [] };
    const composite = new CompositeBackend({ desktop: desktopStub({ connection: 'connected_writable', calls: desktopCalls }) as never, cli: cliStub(cliCalls) as never });
    const sessions = new SessionManager(composite);

    const session = await sessions.createSession({ cwd: '/tmp/p' });
    assert.equal(session.backend, 'desktop', 'a writable Desktop is preferred for new threads');
    assert.equal(session.backendHandleId, 'desktop-thread-1');
    assert.deepEqual(cliCalls.create, [], 'the CLI was not asked to create');
  });
});

test('ownership: aggregate reads route to the CLI when the Desktop is unavailable', async () => {
  await withCliBinary(async () => {
    const desktopCalls: string[] = [];
    const cliCalls: CliStubCalls = { create: [], send: [], read: [] };
    const composite = new CompositeBackend({ desktop: desktopStub({ connection: 'not_running', calls: desktopCalls }) as never, cli: cliStub(cliCalls) as never });

    const thread = (await composite.getThread('cli-conv-1')) as { title: string };
    assert.equal(thread.title, 'CLI conversation', 'getThread served by the CLI chat store');
    assert.deepEqual(cliCalls.read, ['getThread:cli-conv-1']);

    const threads = (await composite.listThreads()) as Array<{ id: string }>;
    assert.equal(threads[0]?.id, 'cli-conv-1');
  });
});

test('ownership: aggregate reads stay on the Desktop while it is connected (even read-only)', async () => {
  await withCliBinary(async () => {
    const calls: string[] = [];
    const composite = new CompositeBackend({
      desktop: { ...desktopStub({ connection: 'connected_read_only', calls }), getThread: async () => { calls.push('desktop.getThread'); return { id: 'desktop-thread-1', title: 'Desktop read' }; } } as never,
      cli: cliStub({ create: [], send: [], read: [] }) as never,
    });

    const thread = (await composite.getThread('desktop-thread-1')) as { title: string };
    assert.equal(thread.title, 'Desktop read', 'reads prefer the connected Desktop even when read-only');
    assert.deepEqual(calls, ['desktop.getThread']);
  });
});

test('ownership: registered threads resolve through the owner of the real handle', async () => {
  const desktopCalls: string[] = [];
  const composite = new CompositeBackend({ desktop: desktopStub({ connection: 'connected_writable', calls: desktopCalls }) as never, cli: cliStub({ create: [], send: [], read: [] }) as never });
  const sessions = new SessionManager(composite);

  const session = await sessions.registerExisting({ backendSessionId: 'desktop-thread-1', cwd: '/tmp/p' });
  assert.equal(session.backend, 'desktop', 'a Desktop thread id resolves to the Desktop owner');
  assert.equal(session.backendHandleId, 'desktop-thread-1');
});

test('ownership: turns on registered sessions keep using the owner backend and handle', async () => {
  await withCliBinary(async () => {
    const desktopCalls: string[] = [];
    const cliCalls: CliStubCalls = { create: [{ id: 'cli-session-1' }], send: [], read: [] };
    const composite = new CompositeBackend({ desktop: desktopStub({ connection: 'not_running', calls: desktopCalls }) as never, cli: cliStub(cliCalls) as never });
    const sessions = new SessionManager(composite);

    const session = await sessions.createSession({ cwd: '/tmp/p' });
    const turns = new TurnManager(sessions);
    const turn = await turns.startTurn(session.id, { text: 'continue' });
    assert.equal(turn.state, 'completed');
    assert.deepEqual(cliCalls.send.map((c) => c.id), ['cli-session-1'], 'routed by the exact CLI handle');
    assert.deepEqual(desktopCalls, [], 'the Desktop is absent and must never be called');
  });
});


test('ownership: direct reads honor a remembered CLI owner even when Desktop is connected', async () => {
  const desktopCalls: string[] = [];
  const cliCalls: CliStubCalls = { create: [], send: [], read: [] };
  const desktop = {
    ...desktopStub({ connection: 'connected_writable', calls: desktopCalls }),
    getThread: async (id: string) => { desktopCalls.push(`desktop.getThread:${id}`); return { id, title: 'Desktop thread' }; },
    getMessages: async (id: string) => { desktopCalls.push(`desktop.getMessages:${id}`); return []; },
  };
  const composite = new CompositeBackend({ desktop: desktop as never, cli: cliStub(cliCalls) as never });
  composite.useExisting('cli', 'cli-conv-1', '/tmp/p');

  const cliThread = await composite.getThread('cli-conv-1') as { title?: string };
  assert.equal(cliThread.title, 'CLI conversation');
  const cliMessages = await composite.getMessages('cli-conv-1') as unknown[];
  assert.equal(cliMessages.length, 1);
  assert.deepEqual(cliCalls.read, ['getThread:cli-conv-1', 'getMessages:cli-conv-1']);
  assert.equal(desktopCalls.length, 0, 'connected Desktop must not steal reads for a remembered CLI conversation');
});

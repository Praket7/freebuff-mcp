import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../src/bridge/session-manager.js';
import { TurnManager } from '../src/bridge/turn-manager.js';
import { FreebuffBackend, BackendSession, BackendTurnResult, BackendEventInput, BridgeError, ErrorCodes } from '../src/bridge/types.js';

interface FakeOptions {
  fail?: boolean;
  hang?: Promise<void>;
  events?: BackendEventInput[];
  onSend?: (session: BackendSession, text: string, signal?: AbortSignal) => void;
  refusalDelayMs?: number;
  /** Emulate a backend with a persistent stream (Desktop-like). */
  streamHealth?: boolean;
}

function fakeBackend(options: FakeOptions = {}): FreebuffBackend & { callCount: number } {
  let calls = 0;
  const backend = {
    kind: 'desktop' as const,
    get callCount() { return calls; },
    async probe() {
      return { backend: 'desktop', connection: 'connected_writable', authorization: 'write_authorized', liveProgress: 'connected', canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] };
    },
    async createSession({ cwd }: { cwd: string }) {
      calls += 1;
      return { id: `bridge-${calls}`, backend: 'desktop' as const, backendSessionId: `real-thread-${calls}`, cwd };
    },
    async sendMessage({ session, text, signal, onEvent }: { session: BackendSession; text: string; signal?: AbortSignal; onEvent?: (event: BackendEventInput) => void }): Promise<BackendTurnResult> {
      calls += 1;
      options.onSend?.(session, text, signal);
      for (const event of options.events ?? []) onEvent?.(event);
      if (options.hang) {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          options.hang!.then(() => resolve()).catch(reject);
        });
      }
      if (options.fail) return { state: 'failed', error: 'injected backend failure' };
      return { state: 'completed', result: { echoed: text } };
    },
    async stop() { /* not used directly here */ },
    ...(options.streamHealth === undefined ? {} : {
      onStreamHealth(listener: (connected: boolean) => void) {
        listener(Boolean(options.streamHealth));
        return () => undefined;
      },
    }),
    dispose() { /* nothing */ },
  };
  return backend as unknown as FreebuffBackend & { callCount: number };
}

test('session manager: bridge id differs from backend id and backend identity is preserved', async () => {
  const manager = new SessionManager(fakeBackend());
  const session = await manager.createSession({ cwd: '/tmp/project' });
  assert.notEqual(session.id, session.backendSessionId, 'bridge and backend ids are distinct');
  assert.match(session.backendSessionId ?? '', /^real-thread-/, 'real backend identity preserved');
});

test('turn manager: full turn lifecycle with progress events mapped to the correct turn', async () => {
  const backend = fakeBackend({
    events: [
      { threadId: 'real-thread-1', type: 'phase', phase: 'reading_files', message: 'Reading src/index.ts' },
      { threadId: 'real-thread-1', type: 'tool_started', tool: 'run_terminal_command' },
      { threadId: 'real-thread-1', type: 'completed' },
    ],
  });
  const manager = new SessionManager(backend);
  const turns = new TurnManager(manager);
  const session = await manager.createSession({ cwd: '/tmp/project' });
  const turn = await turns.startTurn(session.id, { text: 'do the thing' });
  assert.equal(turn.state, 'completed');
  assert.ok(turn.backendTurnId === undefined || typeof turn.backendTurnId === 'string');
  const page = manager.events.read({ turnId: turn.id });
  const types = page.events.map((e) => e.type);
  assert.ok(types.includes('queued'));
  assert.ok(types.includes('turn_started'));
  assert.ok(types.includes('phase'));
  assert.ok(types.includes('tool_started'));
  assert.ok(types.includes('completed'));
  // All events belong to this turn and session.
  assert.ok(page.events.every((e) => e.sessionId === session.id));
});

test('turn manager: failed turn surfaces error and terminal state', async () => {
  const manager = new SessionManager(fakeBackend({ fail: true }));
  const turns = new TurnManager(manager);
  const session = await manager.createSession({ cwd: '/tmp/project' });
  const turn = await turns.startTurn(session.id, { text: 'break' });
  assert.equal(turn.state, 'failed');
  assert.match(turn.error ?? '', /injected backend failure/);
  assert.equal(session.state, 'ready', 'session clears running state after terminal turn');
});

test('session manager: cancellation aborts the turn and clears active state', async () => {
  let observedSignal: AbortSignal | undefined;
  const manager = new SessionManager(fakeBackend({
    onSend: (_session, _text, signal) => { observedSignal = signal; },
    hang: new Promise(() => { /* hang until aborted */ }),
  }));
  const session = await manager.createSession({ cwd: '/tmp/project' });
  const handle = manager.startTurn(session.id, { text: 'long task' });
  // Give the turn a tick to start, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cancelled = manager.cancelTurn(session.id, handle.turn.id);
  assert.equal(cancelled, true);
  const turn = await handle.done;
  assert.equal(turn.state, 'cancelled');
  assert.ok(observedSignal?.aborted, 'backend received the abort');
  assert.equal(session.activeTurnId, undefined, 'active turn cleared');
});

test('session manager: second turn on the same session is rejected while one is active', async () => {
  const manager = new SessionManager(fakeBackend());
  const session = await manager.createSession({ cwd: '/tmp/project' });
  // Serial turns succeed.
  const turn1 = await new TurnManager(manager).startTurn(session.id, { text: 'first' });
  assert.equal(turn1.state, 'completed');
  const turn2 = await new TurnManager(manager).startTurn(session.id, { text: 'second' });
  assert.equal(turn2.state, 'completed');
});

test('session manager: two sessions in the same project are independent with no event leakage', async () => {
  const emittedByThread = new Map<string, string>();
  const backend = fakeBackend({
    events: [{ threadId: 'real-thread-x', type: 'phase', message: 'thread x progress' }],
  });
  const manager = new SessionManager(backend);
  const a = await manager.createSession({ cwd: '/tmp/project' });
  const b = await manager.createSession({ cwd: '/tmp/project' });
  assert.notEqual(a.id, b.id);
  await new TurnManager(manager).startTurn(a.id, { text: 'work a' });
  await new TurnManager(manager).startTurn(b.id, { text: 'work b' });
  const eventsA = manager.events.read({ sessionId: a.id }).events;
  const eventsB = manager.events.read({ sessionId: b.id }).events;
  assert.ok(eventsA.length > 0 && eventsB.length > 0);
  assert.ok(eventsA.every((e) => e.sessionId === a.id));
  assert.ok(eventsB.every((e) => e.sessionId === b.id));
  const idsA = new Set(eventsA.map((e) => e.turnId));
  const idsB = new Set(eventsB.map((e) => e.turnId));
  for (const id of idsA) assert.ok(!idsB.has(id), 'no shared turn ids across sessions');
});

test('session manager: backend stream health reaches the canonical event store, not just the legacy runtime', () => {
  // Regression: `connected` was only ever set by the legacy runtime, so the
  // canonical layer (MCP v2 / HTTP / ACP) reported connected:false and
  // stale:true even while progress events were flowing.
  const healthy = new SessionManager(fakeBackend({ streamHealth: true }));
  const healthySnapshot = healthy.events.progress('any-thread', 0, 1);
  assert.equal(healthySnapshot.connected, true, 'a connected backend reports connected');

  const down = new SessionManager(fakeBackend({ streamHealth: false }));
  assert.equal(down.events.progress('any-thread', 0, 1).connected, false, 'a disconnected backend reports disconnected');
});

test('session manager: a backend with no persistent stream tracks turn-scoped liveness', async () => {
  const manager = new SessionManager(fakeBackend());
  const session = await manager.createSession({ cwd: '/tmp/project' });
  const started = manager.startTurn(session.id, { text: 'work' });
  assert.equal(manager.events.isConnected, true, 'live while a turn runs');
  await started.done;
  assert.equal(manager.events.isConnected, false, 'no longer live once the turn is terminal');
});

test('session manager: unknown session and unknown turn produce structured errors', async () => {
  const manager = new SessionManager(fakeBackend());
  assert.throws(() => manager.startTurn('nope', { text: 'x' }), (error: unknown) => error instanceof BridgeError && error.code === ErrorCodes.SESSION_NOT_FOUND);
  const turns = new TurnManager(manager);
  assert.throws(() => turns.getTurn('missing'), (error: unknown) => error instanceof BridgeError && error.code === ErrorCodes.TURN_NOT_FOUND);
});

test('turn manager: waitForTurn returns terminal snapshot and cursor advances past 100 events', async () => {
  const manager = new SessionManager(fakeBackend());
  const turns = new TurnManager(manager);
  const session = await manager.createSession({ cwd: '/tmp/project' });
  const handle = manager.startTurn(session.id, { text: 'work' });
  // Simulate >100 progress events streaming in for this turn's thread.
  const threadId = (await Promise.resolve(session.backendSessionId)) ?? session.id;
  for (let i = 0; i < 120; i++) manager.events.append({ sessionId: session.id, turnId: handle.turn.id, threadId, type: 'phase', message: `step ${i}` });
  const snapshot = await turns.waitForTurn(handle.turn.id, 5000, 0, 100);
  assert.ok(snapshot.events.length <= 100);
  assert.ok((snapshot.nextSequence ?? 0) > 100, 'cursor advanced beyond 100');
  await handle.done;
});

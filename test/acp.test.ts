import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../src/bridge/session-manager.js';
import { TurnManager } from '../src/bridge/turn-manager.js';
import { FreebuffBackend, BackendSession, BackendTurnResult, BackendEventInput } from '../src/bridge/types.js';

/**
 * The ACP adapter's prompt loop is exercised at the bridge level: session/new
 * maps to a real backend identity, prompt waits for the terminal state, and
 * assistant deltas stream through the shared event store with an advancing
 * cursor (no duplicate accumulation, no afterSequence=0 polling).
 */
function acpStyleBackend(): FreebuffBackend {
  let calls = 0;
  return {
    kind: 'desktop',
    async probe() { return { backend: 'desktop', connection: 'connected_writable', authorization: 'write_authorized', liveProgress: 'connected', canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }; },
    async createSession({ cwd }: { cwd: string }) {
      calls += 1;
      return { id: `acp-bridge-${calls}`, backend: 'desktop' as const, backendSessionId: `freebuff-thread-${calls}`, cwd };
    },
    async sendMessage({ session, text, onEvent, signal }: { session: BackendSession; text: string; onEvent?: (e: BackendEventInput) => void; signal?: AbortSignal }): Promise<BackendTurnResult> {
      // Stream cumulative-looking assistant snapshots as deltas (bridge never re-sends the accumulation).
      const words = text.split(' ');
      for (const word of words) {
        onEvent?.({ threadId: session.backendSessionId, type: 'assistant_delta', message: `${word} ` });
        if (signal?.aborted) return { state: 'cancelled' };
      }
      onEvent?.({ threadId: session.backendSessionId, type: 'assistant_message', message: 'Final message.' });
      return { state: 'completed', result: { ok: true } };
    },
    async stop() { return undefined; },
    dispose() { return undefined; },
  };
}

test('acp: session/new maps ACP identity to a real backend identity', async () => {
  const sessions = new SessionManager(acpStyleBackend());
  const session = await sessions.createSession({ cwd: '/tmp/acp' });
  assert.match(session.backendSessionId ?? '', /^freebuff-thread-/);
  assert.notEqual(session.id, session.backendSessionId);
  // The ACP adapter would keep its own random UUID; it must never be used as
  // the backend conversation id.
});

test('acp: prompt result arrives only after the terminal state, with deltas streamed once', async () => {
  const backend = acpStyleBackend();
  const sessions = new SessionManager(backend);
  const turns = new TurnManager(sessions);
  const session = await sessions.createSession({ cwd: '/tmp/acp' });
  const threadKey = session.backendSessionId ?? session.id;
  const emitted: string[] = [];
  let cursor = 0;
  const handle = sessions.startTurn(session.id, { text: 'hello streaming world' });
  // Subscribe exactly like the ACP prompt handler does.
  const unsubscribe = sessions.events.subscribe((threadId) => {
    if (threadId !== threadKey) return;
    const page = sessions.events.read({ threadId: threadKey, afterSequence: cursor, limit: 100 });
    for (const event of page.events) {
      cursor = Math.max(cursor, event.sequence);
      if ((event.type === 'assistant_delta' || event.type === 'assistant_message') && event.message) emitted.push(event.message);
    }
  });
  const turn = await handle.done;
  unsubscribe();
  assert.equal(turn.state, 'completed');
  assert.deepEqual(emitted, ['hello ', 'streaming ', 'world ', 'Final message.'], 'each delta emitted exactly once, no cumulative duplicates');
});

test('acp: cursor advances past 100 events without re-reading from zero', async () => {
  const sessions = new SessionManager(acpStyleBackend());
  const session = await sessions.createSession({ cwd: '/tmp/acp' });
  const threadKey = session.backendSessionId ?? session.id;
  let cursor = 0;
  let readsFromZero = 0;
  const handle = sessions.startTurn(session.id, { text: 'work' });
  const unsubscribe = sessions.events.subscribe((threadId) => {
    if (threadId !== threadKey) return;
    if (cursor === 0) readsFromZero += 1;
    const page = sessions.events.read({ threadId: threadKey, afterSequence: cursor, limit: 100 });
    for (const event of page.events) cursor = Math.max(cursor, event.sequence);
  });
  for (let i = 0; i < 150; i++) sessions.events.append({ sessionId: session.id, turnId: handle.turn.id, threadId: threadKey, type: 'phase', message: `s${i}` });
  await new Promise((r) => setTimeout(r, 20));
  unsubscribe();
  assert.ok(cursor > 100, `cursor advanced past 100 (got ${cursor})`);
  assert.equal(readsFromZero, 1, 'exactly one initial read at cursor 0');
  await handle.done;
});

test('acp: cancelled prompt reports cancelled, not a refusal', async () => {
  const sessions = new SessionManager(acpStyleBackend());
  const session = await sessions.createSession({ cwd: '/tmp/acp' });
  const handle = sessions.startTurn(session.id, { text: 'long' });
  await sessions.cancelTurn(session.id, handle.turn.id);
  const turn = await handle.done;
  assert.equal(turn.state, 'cancelled');
});

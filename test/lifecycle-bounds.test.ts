import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../src/bridge/session-manager.js';
import { EventStore } from '../src/bridge/event-store.js';
import { FreebuffBackend } from '../src/bridge/types.js';

/** Item 10: lifecycle maps stay bounded under stress; active state survives. */

function stressBackend(): FreebuffBackend {
  let n = 0;
  return {
    kind: 'desktop',
    probe: async () => ({}),
    createSession: async ({ cwd }: { cwd: string }) => {
      n += 1;
      return { id: `h${n}`, backend: 'desktop' as const, backendSessionId: `t${n}`, cwd };
    },
    sendMessage: async () => ({ state: 'completed' as const, result: {} }),
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
}

test('bounds: 10k sessions stay capped and the newest active session survives', async () => {
  const manager = new SessionManager(stressBackend());
  for (let i = 0; i < 10_000; i++) {
    await manager.createSession({ cwd: '/tmp/p' });
  }
  const size = manager.listSessions().length;
  assert.ok(size <= 1_100, `sessions bounded (got ${size})`);

  // A session with a live turn is never evicted, even past the cap.
  const hanging = new SessionManager({
    kind: 'desktop',
    probe: async () => ({}),
    createSession: async ({ cwd }: { cwd: string }) => ({ id: 'h', backend: 'desktop' as const, backendSessionId: 't', cwd }),
    sendMessage: async () => new Promise(() => { /* hang */ }),
    dispose: () => undefined,
  } as unknown as FreebuffBackend);
  const live = await hanging.createSession({ cwd: '/tmp/p' });
  const handle = hanging.startTurn(live.id, { text: 'long' });
  await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 1_500; i++) {
    await hanging.createSession({ cwd: '/tmp/p' });
  }
  assert.ok(hanging.getSession(live.id), 'the session with the live turn was retained');
  // Cap + slack + the one protected live session (never evictable): bounded,
  // not the 1501 an unbounded map would hold.
  assert.ok(hanging.listSessions().length <= 1_200, `still bounded with a live turn present (got ${hanging.listSessions().length})`);
  // A backend that ignores abort never settles `done`; cancellation still
  // reports the truth without hanging the test.
  const outcome = await hanging.cancelTurn(live.id, handle.turn.id);
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.stopped, false, 'no stop operation exists on this backend');
});

test('bounds: a live thread is never evicted even under pressure', () => {
  const store = new EventStore();
  // Create thread-0 with an event, then mark it live (a running CLI/PTY turn).
  store.append({ sessionId: 's', turnId: 'turn-0', threadId: 'thread-0', type: 'phase', message: 'm0' });
  store.setThreadLive('thread-0', true);
  // Fill past the cap with other threads.
  for (let i = 1; i < 6_000; i++) {
    store.append({ sessionId: 's', turnId: `turn-${i}`, threadId: `thread-${i}`, type: 'phase', message: `m${i}` });
  }
  // thread-0's live flag protects it from eviction even though its
  // turn state is not recorded in EventStore.turns.
  assert.ok(store.progress('thread-0', 0, 1).events.length > 0, 'live thread was retained');
  const size = (store as unknown as { threads: Map<string, unknown> }).threads.size;
  assert.ok(size <= 5_500, `thread buckets bounded with a live thread (got ${size})`);
});

test('bounds: 10k thread buckets stay capped, newest readable, expired dropped', () => {
  const store = new EventStore();
  for (let i = 0; i < 10_000; i++) {
    store.append({ sessionId: 's', turnId: `turn-${i}`, threadId: `thread-${i}`, type: 'phase', message: `m${i}` });
  }
  const size = (store as unknown as { threads: Map<string, unknown> }).threads.size;
  assert.ok(size <= 5_500, `thread buckets bounded (got ${size})`);
  assert.equal(store.progress('thread-9999', 0, 10).events.length, 1, 'newest thread readable');
  assert.equal(store.progress('thread-0', 0, 10).events.length, 0, 'oldest bucket evicted');

  // Fully-expired buckets are dropped by the sweep.
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  for (let i = 0; i < 3_000; i++) {
    store.append({ sessionId: 's', turnId: `old-${i}`, threadId: `old-${i}`, type: 'phase', timestamp: old });
  }
  store.append({ sessionId: 's', turnId: 'fresh', threadId: 'fresh', type: 'phase' });
  assert.equal(store.progress('old-0', 0, 10).events.length, 0, 'expired buckets swept');
});

test('bounds: running turn state survives turn-state cap and thread-bucket pressure', () => {
  const store = new EventStore();
  // Create a running turn (Desktop-style) and register its state.
  // This exercises the real state-registration path: setTurnState('running')
  // is called by SessionManager when a turn transitions to running.
  store.setTurnState('thread-running', 'session-0', 'turn-running', 'running');
  // Verify the turn state is recorded
  assert.equal(store.turnState('turn-running'), 'running');

  // Create >2,000 terminal turns to exceed the turn-state cap (2,000).
  // These will fill the turns map and force eviction.
  for (let i = 0; i < 2_500; i++) {
    store.setTurnState(`thread-${i}`, `session-${i}`, `turn-${i}`, 'completed');
  }

  // The original running turn state must survive because it's non-terminal.
  // Terminal states should be evicted first.
  assert.equal(store.turnState('turn-running'), 'running', 'running turn state must not be evicted');

  // Now add >5,500 thread buckets to trigger thread-bucket pruning.
  // The running turn's thread should have events from the setTurnState call.
  for (let i = 0; i < 6_000; i++) {
    store.append({ sessionId: 's', turnId: `turn-bucket-${i}`, threadId: `thread-bucket-${i}`, type: 'phase', message: `m${i}` });
  }

  // The running thread should still exist (protected by turn state + threadLive)
  assert.ok(store.progress('thread-running', 0, 1).events.length > 0, 'running thread was retained');

  // Memory should remain bounded
  const turnSize = (store as unknown as { turns: Map<string, unknown> }).turns.size;
  const threadSize = (store as unknown as { threads: Map<string, unknown> }).threads.size;
  assert.ok(turnSize <= 2_500, `turn states bounded (got ${turnSize})`);
  assert.ok(threadSize <= 5_501, `thread buckets bounded (got ${threadSize})`);
});

test('bounds: 10k thread buckets stay capped, newest readable, expired dropped', () => {
});

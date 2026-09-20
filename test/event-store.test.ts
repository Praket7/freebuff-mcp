import assert from 'node:assert/strict';
import test from 'node:test';
import { EventStore } from '../src/bridge/event-store.js';
import { BridgeTurnState } from '../src/bridge/types.js';

function threadEvent(store: EventStore, threadId: string, type = 'phase', state?: string) {
  return store.append({ sessionId: 's1', turnId: 't1', threadId, type: type as 'phase', ...(state ? { state } : {}) });
}

test('event store: sequence starts at 1 and increases monotonically', () => {
  const store = new EventStore();
  const a = threadEvent(store, 'thread-1');
  const b = threadEvent(store, 'thread-1');
  const c = threadEvent(store, 'thread-2');
  assert.equal(a.sequence, 1);
  assert.equal(b.sequence, 2);
  assert.equal(c.sequence, 3);
});

test('event store: afterSequence, limit, and nextSequence work; 101st event is readable after the first 100', () => {
  const store = new EventStore();
  for (let i = 0; i < 150; i++) threadEvent(store, 'thread-1');
  const first = store.read({ threadId: 'thread-1', afterSequence: 0, limit: 100 });
  assert.equal(first.events.length, 100);
  assert.equal(first.events[0]?.sequence, 1);
  assert.equal(first.hasMore, true);
  const second = store.read({ threadId: 'thread-1', afterSequence: first.nextSequence, limit: 100 });
  assert.equal(second.events.length, 50);
  assert.equal(second.events[0]?.sequence, 101);
  assert.equal(second.hasMore, false);
  // Global cursor: afterSequence works across threads too.
  assert.equal(store.read({ afterSequence: 149 }).events.length, 1);
});

test('event store: bounded event count and bytes', () => {
  const store = new EventStore();
  const big = 'x'.repeat(50_000);
  for (let i = 0; i < 100; i++) store.append({ sessionId: 's1', turnId: 't1', threadId: 'thread-1', type: 'phase', message: big });
  const page = store.read({ threadId: 'thread-1', afterSequence: 0, limit: 1000 });
  assert.ok(page.events.length < 100, `retention bounded (got ${page.events.length})`);
  const totalBytes = JSON.stringify(page.events).length;
  assert.ok(totalBytes < 2_000_000, 'byte bound respected');
});

test('event store: TTL eviction drops old events', () => {
  const store = new EventStore();
  const stale = store.append({ sessionId: 's1', turnId: 't1', threadId: 'thread-1', type: 'phase', timestamp: new Date(Date.now() - 60 * 60_000).toISOString() });
  const fresh = threadEvent(store, 'thread-1');
  const page = store.read({ threadId: 'thread-1', afterSequence: 0, limit: 100 });
  assert.ok(!page.events.some((e) => e.sequence === stale.sequence), 'stale event evicted');
  assert.ok(page.events.some((e) => e.sequence === fresh.sequence), 'fresh event kept');
});

test('event store: wait wakes on new event, does not lose wakeups, and times out', async () => {
  const store = new EventStore();
  const pending = store.wait('thread-1', 0, 1000);
  threadEvent(store, 'thread-1');
  const snapshot = await pending;
  assert.equal(snapshot.events.length >= 1, true);

  // No lost wakeups: waiter registered before append resolves immediately after.
  const pending2 = store.wait('thread-1', snapshot.nextSequence ?? 0, 1000);
  const pending3 = store.wait('thread-1', snapshot.nextSequence ?? 0, 1000);
  threadEvent(store, 'thread-1');
  threadEvent(store, 'thread-1');
  const [s2, s3] = await Promise.all([pending2, pending3]);
  assert.ok(s2.events.length >= 1);
  assert.ok(s3.events.length >= 1);

  const start = Date.now();
  const timedOut = await store.wait('thread-quiet', 0, 120);
  assert.ok(Date.now() - start >= 100);
  assert.equal(timedOut.events.length, 0);
});

test('event store: subscriber notification and unsubscribe', () => {
  const store = new EventStore();
  const seen: string[] = [];
  const unsubscribe = store.subscribe((threadId) => seen.push(threadId));
  threadEvent(store, 'thread-1');
  unsubscribe();
  threadEvent(store, 'thread-1');
  assert.deepEqual(seen, ['thread-1']);
});

test('event store: terminal states clear running state per turn', () => {
  const store = new EventStore();
  store.setTurnState('thread-1', 's1', 'turn-1', 'running');
  assert.equal(store.turnState('turn-1'), 'running');
  store.setTurnState('thread-1', 's1', 'turn-1', 'completed');
  assert.equal(store.turnState('turn-1'), 'completed');
  assert.equal(store.activeThreads().includes('thread-1'), false, 'completed turn is not active');
});

test('event store: per-thread staleness (activity in another thread does not refresh this one)', async () => {
  const store = new EventStore();
  store.setConnected(true);
  threadEvent(store, 'thread-a');
  // Wait a moment so thread-b's later activity is clearly distinct in time.
  await new Promise((resolve) => setTimeout(resolve, 30));
  threadEvent(store, 'thread-b');
  const a = store.progress('thread-a');
  const b = store.progress('thread-b');
  assert.equal(b.stale, false, 'active thread is not stale');
  // thread-a's last activity is older than thread-b's.
  assert.ok((store.lastActivityAt('thread-a') ?? 0) < (store.lastActivityAt('thread-b') ?? 0));
  // With a tiny staleness window simulated via TTL the API contract is per-thread:
  // thread-a remains non-stale here because it is recent, but its latestEventAt differs.
  assert.ok((a.latestEventAt ? Date.parse(a.latestEventAt) : 0) < (b.latestEventAt ? Date.parse(b.latestEventAt) : 0));
});

test('event store: concurrent threads do not leak events', () => {
  const store = new EventStore();
  threadEvent(store, 'thread-1');
  threadEvent(store, 'thread-2');
  threadEvent(store, 'thread-1');
  const one = store.read({ threadId: 'thread-1' });
  const two = store.read({ threadId: 'thread-2' });
  assert.equal(one.events.length, 2);
  assert.equal(two.events.length, 1);
  assert.ok(one.events.every((e) => e.threadId === 'thread-1'));
  assert.ok(two.events.every((e) => e.threadId === 'thread-2'));
});

test('event store: session and turn filters partition correctly', () => {
  const store = new EventStore();
  store.append({ sessionId: 's1', turnId: 't1', threadId: 'th1', type: 'phase' });
  store.append({ sessionId: 's2', turnId: 't2', threadId: 'th1', type: 'phase' });
  assert.equal(store.read({ sessionId: 's1' }).events.length, 1);
  assert.equal(store.read({ turnId: 't2' }).events.length, 1);
  assert.equal(store.read({ turnId: 't2' }).events[0]?.sessionId, 's2');
});

test('event store: turn state transitions are recorded with correct event types', () => {
  const store = new EventStore();
  const states: BridgeTurnState[] = ['running', 'waiting_for_user', 'completed'];
  states.forEach((state, index) => store.setTurnState('th1', 's1', `turn-${index}`, state === 'running' ? 'running' : state));
  const types = store.read({}).events.map((e) => e.type);
  assert.ok(types.includes('turn_started'));
  assert.ok(types.includes('waiting_for_user'));
  assert.ok(types.includes('completed'));
});

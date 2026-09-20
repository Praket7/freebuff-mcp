import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSseFrame, SseClient } from '../src/desktop/sse.js';

/** P1: SSE recovery gaps — ids, retry clamp, partial frames, failure hooks. */

test('sse: id-only and retry-only frames update recovery state without emitting', () => {
  assert.deepEqual(parseSseFrame('id: 9')?.id, '9');
  assert.equal(parseSseFrame('retry: 5000')?.retryMs, 5000);
  assert.equal(parseSseFrame(': heartbeat'), null, 'a pure comment is still nothing');
});

test('sse: an id-only frame moves Last-Event-ID but emits no event', async () => {
  const originalFetch = globalThis.fetch;
  const events: unknown[] = [];
  let served = false;
  globalThis.fetch = (async () => {
    if (!served) {
      served = true;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('id: 11\n\n'));
          c.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200 }) as Response;
    }
    // Reconnects hold open so the fixture is delivered exactly once.
    return new Response(new ReadableStream<Uint8Array>({ start() { /* hold */ } }), { status: 200 }) as Response;
  }) as typeof fetch;
  const client = new SseClient({ url: () => new URL('http://127.0.0.1:1/events'), onEvent: (e) => events.push(e), baseDelayMs: 5, maxDelayMs: 10, connectionTimeoutMs: 500 });
  try {
    client.start();
    for (let i = 0; i < 50 && events.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(events.length, 1);
    assert.equal(client.lastEventId, '11');
  } finally {
    client.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('sse: a trailing partial frame is discarded, never delivered half', async () => {
  const originalFetch = globalThis.fetch;
  const events: unknown[] = [];
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"partial": tru'));
        c.close();
      },
    });
    return new Response(body, { status: 200 }) as Response;
  }) as typeof fetch;
  const client = new SseClient({ url: () => new URL('http://127.0.0.1:1/events'), onEvent: (e) => events.push(e), baseDelayMs: 5, maxDelayMs: 10, connectionTimeoutMs: 500 });
  try {
    client.start();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(events.length, 0, 'half a payload must not arrive as an event');
  } finally {
    client.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('sse: a rogue server retry never pushes backoff past the max', async () => {
  const originalFetch = globalThis.fetch;
  let connections = 0;
  globalThis.fetch = (async () => {
    connections += 1;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('retry: 1000000\ndata: {"n":1}\n\n')); c.close(); },
    });
    return new Response(body, { status: 200 }) as Response;
  }) as typeof fetch;
  const client = new SseClient({ url: () => new URL('http://127.0.0.1:1/events'), onEvent: () => undefined, baseDelayMs: 5, maxDelayMs: 20, connectionTimeoutMs: 500 });
  try {
    client.start();
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(connections >= 3, `reconnects stayed fast despite retry:1000000 (${connections})`);
  } finally {
    client.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('sse: a recreated client seeds Last-Event-ID from the owner callback', async () => {
  const originalFetch = globalThis.fetch;
  const seen: Array<string | undefined> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('last-event-id') ?? undefined);
    return new Response(new ReadableStream<Uint8Array>({ start() { /* hold */ } }), { status: 200 }) as Response;
  }) as typeof fetch;
  const client = new SseClient({ url: () => new URL('http://127.0.0.1:1/events'), onEvent: () => undefined, lastEventId: () => 'ext-5', baseDelayMs: 5, maxDelayMs: 10, connectionTimeoutMs: 500 });
  try {
    client.start();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(seen[0], 'ext-5', 'the owner-provided id seeds the first request');
  } finally {
    client.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('sse: repeated failures invoke the persistent-failure hook for rediscovery', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  let hookCalls = 0;
  const client = new SseClient({
    url: () => new URL('http://127.0.0.1:1/events'),
    onEvent: () => undefined,
    baseDelayMs: 5,
    maxDelayMs: 10,
    connectionTimeoutMs: 200,
    maxConsecutiveFailures: 3,
    onPersistentFailure: () => { hookCalls += 1; },
  });
  try {
    client.start();
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(hookCalls >= 1, 'the owner was told the URL looks dead');
  } finally {
    client.dispose();
    globalThis.fetch = originalFetch;
  }
});

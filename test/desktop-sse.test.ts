import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSseFrame, splitSseFrames, SseClient } from '../src/desktop/sse.js';

test('sse: comments, multiline data, event/id/retry fields', () => {
  const frame = parseSseFrame(': keep-alive\nevent: running\ndata: {"a":1}\ndata: {"b":2}\nid: 42\nretry: 1500');
  assert.equal(frame?.event, 'running');
  assert.equal(frame?.data, '{"a":1}\n{"b":2}');
  assert.equal(frame?.id, '42');
  assert.equal(frame?.retryMs, 1500);
  assert.equal(parseSseFrame(': heartbeat'), null);
});

test('sse: LF and CRLF both split frames', () => {
  const lf = splitSseFrames('data: a\n\ndata: b\n\n');
  assert.equal(lf.frames.length, 2);
  assert.equal(lf.rest, '');
  const crlf = splitSseFrames('data: a\r\n\r\ndata: b\r\n\r\n');
  assert.equal(crlf.frames.length, 2);
  const partial = splitSseFrames('data: x\n\ndata: partial');
  assert.equal(partial.rest, 'data: partial');
});

test('sse: oversized frame is rejected', () => {
  assert.equal(parseSseFrame('data: ' + 'x'.repeat(600_000)), null);
});

function streamClient(chunks: string[], options: { delayMs?: number } = {}): { client: SseClient; events: Array<{ event?: string; data: string; id?: string }>; connections: boolean[]; cleanup: () => void } {
  const events: Array<{ event?: string; data: string; id?: string }> = [];
  const connections: boolean[] = [];
  const encoder = new TextEncoder();
  let index = 0;
  const client = new SseClient({
    url: () => new URL('http://127.0.0.1:1/events'),
    onEvent: (event) => events.push(event),
    onConnectionChange: (connected) => connections.push(connected),
    baseDelayMs: 5,
    maxDelayMs: 10,
    connectionTimeoutMs: 1000,
  });
  // Patch fetch to stream our chunks then close.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < chunks.length) {
          if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
          controller.enqueue(encoder.encode(chunks[index]));
          index += 1;
        } else {
          controller.close();
        }
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) as Response;
  }) as typeof fetch;
  return { client, events, connections, cleanup: () => { globalThis.fetch = originalFetch; } };
}

test('sse: events split across chunks, multiple per chunk, and JSON split inside data', async () => {
  // Frame 1 arrives split across two chunks mid-JSON; frame 2 arrives whole.
  const { client, events, cleanup } = streamClient(['event: phase\ndata: {"threadId":"t1",', '"state":"running"}\n\nevent: phase\ndata: {"threadId":"t1"}\n\n']);
  client.start();
  for (let i = 0; i < 50 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  cleanup();
  client.dispose();
  assert.equal(events.length, 2, `got ${JSON.stringify(events)}`);
  assert.equal(events[0]?.data, '{"threadId":"t1","state":"running"}');
});

test('sse: Last-Event-ID is sent on reconnect after receiving an id', async () => {
  const ids: Array<string | undefined> = [];
  const originalFetch = globalThis.fetch;
  let first = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    ids.push(new Headers(init?.headers).get('last-event-id') ?? undefined);
    if (first) {
      first = false;
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('id: 7\ndata: {"x":1}\n\n')); c.close(); } });
      return new Response(body, { status: 200 }) as Response;
    }
    // Second connection stays open until disposed.
    return new Response(new ReadableStream<Uint8Array>({ start() { /* never closes */ } }), { status: 200 }) as Response;
  }) as typeof fetch;
  const client = new SseClient({ url: () => new URL('http://127.0.0.1:1/events'), onEvent: () => undefined, baseDelayMs: 5, maxDelayMs: 10, connectionTimeoutMs: 500 });
  client.start();
  await new Promise((r) => setTimeout(r, 60));
  client.dispose();
  globalThis.fetch = originalFetch;
  assert.equal(client.lastEventId, '7');
  assert.equal(ids[0], undefined, 'no Last-Event-ID on first connect');
  assert.equal(ids[1], '7', 'Last-Event-ID sent on reconnect');
});

test('sse: reconnect happens after connection close with bounded backoff', async () => {
  const originalFetch = globalThis.fetch;
  let connections = 0;
  globalThis.fetch = (async () => {
    connections += 1;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"n":' + connections + '}\n\n')); c.close(); } });
    return new Response(body, { status: 200 }) as Response;
  }) as typeof fetch;
  const client = new SseClient({ url: () => new URL('http://127.0.0.1:1/events'), onEvent: () => undefined, baseDelayMs: 5, maxDelayMs: 15, connectionTimeoutMs: 500 });
  client.start();
  await new Promise((r) => setTimeout(r, 80));
  client.dispose();
  globalThis.fetch = originalFetch;
  assert.ok(connections >= 2, `reconnected after close (${connections} connections)`);
});

test('sse: server retry value is honored', async () => {
  let retrySeen: number | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('retry: 1234\ndata: {"x":1}\n\n')); c.close(); } });
    return new Response(body, { status: 200 }) as Response;
  }) as typeof fetch;
  const client = new SseClient({ url: () => new URL('http://127.0.0.1:1/events'), onEvent: () => undefined, onRetryMs: (ms) => { retrySeen = ms; }, baseDelayMs: 5, maxDelayMs: 10, connectionTimeoutMs: 500 });
  client.start();
  await new Promise((r) => setTimeout(r, 60));
  client.dispose();
  globalThis.fetch = originalFetch;
  assert.equal(retrySeen, 1234);
});

test('sse: a clean end-of-stream reports disconnected, not a permanent connected', async () => {
  // Regression: only the error path cleared the connection flag, so a server
  // that closes cleanly (a Desktop restart) left `connected` true forever
  // while nothing was arriving — the exact false positive the bridge forbids.
  const originalFetch = globalThis.fetch;
  const connections: boolean[] = [];
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"x":1}\n\n')); c.close(); } });
    return new Response(body, { status: 200 }) as Response;
  }) as typeof fetch;
  const client = new SseClient({
    url: () => new URL('http://127.0.0.1:1/events'),
    onEvent: () => undefined,
    onConnectionChange: (connected) => connections.push(connected),
    baseDelayMs: 5,
    maxDelayMs: 15,
    connectionTimeoutMs: 500,
  });
  client.start();
  await new Promise((r) => setTimeout(r, 80));
  client.dispose();
  globalThis.fetch = originalFetch;

  assert.ok(connections.length >= 2, `saw connection transitions: ${connections.join(',')}`);
  assert.equal(connections[0], true, 'the first connection is reported');
  assert.equal(connections[1], false, 'closing the stream reports disconnected');
  // Every reported connection must be followed by a disconnection, so the flag
  // can never stay stuck true.
  for (let i = 0; i < connections.length; i += 2) {
    assert.equal(connections[i], true, `pair ${i} opens with connected`);
    assert.equal(connections[i + 1], false, `pair ${i} closes with disconnected`);
  }
});

test('sse: malformed events and unknown types do not crash the loop', async () => {
  // Raw frames are delivered regardless of payload validity; the consumer (not
  // the transport) decides what to do with malformed data.
  const { client, events, cleanup } = streamClient(['not json\n\ndata: [broken\n\ndata: {"threadId":"t1","state":"running"}\n\n']);
  client.start();
  for (let i = 0; i < 50 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  cleanup();
  client.dispose();
  assert.equal(events.length, 2, 'frames without a data field are dropped, the rest delivered');
});

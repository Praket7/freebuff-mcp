import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopEventClient, ProgressStore, normalizeProgressEvent, parseSseFrame } from '../src/events.js';

test('parses SSE comments and multiline data', () => {
  assert.deepEqual(parseSseFrame(': keep-alive\nevent: assistant_update\ndata: {"threadId":"t"}\ndata: {"text":"ok"}'), { event:'assistant_update', data:'{"threadId":"t"}\n{"text":"ok"}' });
  assert.equal(parseSseFrame(': heartbeat'), null);
  assert.equal(parseSseFrame('data: ' + 'x'.repeat(600_000)), null);
});

test('normalizes, filters, redacts, and classifies progress events', () => {
  const event = normalizeProgressEvent({ threadId:'thread-1', type:'tool_start', tool:'shell', command:'echo authorization=secret', accessToken:'hidden' });
  assert.equal(event?.kind, 'tool_start');
  assert.equal(event?.threadId, 'thread-1');
  assert.match(event?.raw ? JSON.stringify(event.raw) : '', /REDACTED/);
  assert.equal(normalizeProgressEvent({ type:'completed' }), null);
  assert.equal(normalizeProgressEvent({ threadId:'bad/id', type:'x' }), null);
  assert.equal(normalizeProgressEvent({ threadId:'thread-1', type:'future_event' })?.kind, 'unknown');
  assert.equal(normalizeProgressEvent({ threadId:'thread-1', type:'file_edit', files:['src/a.ts'] })?.phase, 'editing_files');
  assert.equal(normalizeProgressEvent({ threadId:'thread-1', type:'permission_required' })?.phase, 'waiting_for_input');
});

test('stores bounded incremental progress and wakes waiters', async () => {
  const store = new ProgressStore();
  store.setConnected(true);
  store.append({ threadId:'thread-1', timestamp:new Date().toISOString(), kind:'turn_state', state:'running' });
  const pending = store.wait('thread-1', 1, 1000);
  store.append({ threadId:'thread-1', timestamp:new Date().toISOString(), kind:'completed', state:'completed' });
  const snapshot = await pending;
  assert.equal(snapshot.events[0]?.kind, 'completed');
  assert.equal(snapshot.nextSequence, 2);
  assert.equal(snapshot.currentState, 'completed');
  assert.equal(snapshot.connected, true);
});

test('event client sends launch ID and filters by thread through the store', async () => {
  const previous = globalThis.fetch; const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('event: running\ndata: {"threadId":"thread-1","state":"running"}\n\n')); controller.close(); } });
    return new Response(body, { status:200, headers:{'content-type':'text/event-stream'} });
  };
  const store = new ProgressStore(); const client = new DesktopEventClient(() => new URL('http://127.0.0.1:55354'), () => 'launch-id', store);
  try { client.start(); for (let i=0; i<20 && !store.read('thread-1').events.length; i++) await new Promise(r => setTimeout(r, 10)); const snapshot = store.read('thread-1'); assert.equal(snapshot.events[0]?.kind, 'turn_state'); assert.equal(requests[0]?.headers.get('x-freebuff-launch-id'), 'launch-id'); } finally { client.dispose(); globalThis.fetch = previous; }
});

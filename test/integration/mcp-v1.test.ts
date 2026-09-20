import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp.js';
import { DesktopOrchestratorRuntime } from '../../src/runtime.js';

const BASE = 'http://127.0.0.1:55354';

/** Read the JSON payload out of a legacy tool result. */
function payload(result: unknown): any {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

/**
 * Mocked Desktop transport: real HTTP shapes, no sockets. `/healthz` succeeds
 * so the launch-ID challenge grants write authorization.
 */
function mockDesktop(): { restore: () => void; previousLaunch: string | undefined } {
  const previous = globalThis.fetch;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  process.env.FREEBUFF_LAUNCH_ID = 'test-launch-id';
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/projects')) {
      return new Response(JSON.stringify({ projects: [{ path: '/tmp/proj', threads: [{ id: 'thread-1', turnState: 'running', title: 'Demo thread' }] }] }), { status: 200 });
    }
    if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.includes('/api/events')) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('event: running\ndata: {"threadId":"thread-1","state":"running"}\n\n')); /* stays open */ },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };
  return {
    previousLaunch,
    restore: () => {
      globalThis.fetch = previous;
      if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID;
      else process.env.FREEBUFF_LAUNCH_ID = previousLaunch;
    },
  };
}

async function connect(runtime: DesktopOrchestratorRuntime, includeWrites = true): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createServer(runtime, includeWrites);
  const client = new Client({ name: 'v1-test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, cleanup: async () => { await client.close(); await server.close(); } };
}

test('integration v1: legacy adapter exposes its tool catalog over the real MCP client', async () => {
  const mock = mockDesktop();
  const runtime = new DesktopOrchestratorRuntime(BASE);
  const { client, cleanup } = await connect(runtime);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const expected of ['freebuff_status', 'list_projects', 'list_threads', 'get_thread', 'get_thread_messages', 'get_thread_progress', 'get_thread_progress_summary', 'watch_thread', 'watch_active_threads', 'send_message', 'stop_thread']) {
      assert.ok(tools.includes(expected), `legacy catalog is missing ${expected}`);
    }
  } finally {
    await cleanup();
    runtime.dispose();
    mock.restore();
  }
});

test('integration v1: status, listing, and progress work on the canonical layer', async () => {
  const mock = mockDesktop();
  const runtime = new DesktopOrchestratorRuntime(BASE);
  const { client, cleanup } = await connect(runtime);
  try {
    const status = payload(await client.callTool({ name: 'freebuff_status', arguments: {} }));
    assert.equal(status.orchestrator, true);
    assert.equal(status.selectedRuntime, 'desktop');
    assert.equal(status.readOnly, false, 'the launch-ID health check granted write authorization');

    const projects = payload(await client.callTool({ name: 'list_projects', arguments: {} }));
    assert.deepEqual((projects as Array<{ path: string }>).map((p) => p.path), ['/tmp/proj']);

    const threads = payload(await client.callTool({ name: 'list_threads', arguments: {} }));
    assert.equal(threads[0]?.id, 'thread-1');
    assert.equal(threads[0]?.state, 'running');

    // Wait for the canonical event stream to deliver the mocked frame.
    let progress: any;
    for (let i = 0; i < 80; i++) {
      progress = payload(await client.callTool({ name: 'get_thread_progress', arguments: { threadId: 'thread-1' } }));
      if (progress.events.length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(progress.events.length >= 1, true, 'the canonical event store received the streamed frame');
    assert.equal(progress.connected, true, 'live progress reflects the real event stream');
    assert.equal(progress.stale, false);
    assert.equal(progress.nextSequence, 1);
    assert.equal(progress.events[0]?.kind, 'turn_state');
    assert.equal(progress.events[0]?.state, 'running');

    // The summary variant never leaks raw event detail.
    const summary = payload(await client.callTool({ name: 'get_thread_progress_summary', arguments: { threadId: 'thread-1' } }));
    assert.deepEqual(summary.events, []);
    assert.equal(summary.latestEventAt !== undefined, true);
  } finally {
    await cleanup();
    runtime.dispose();
    mock.restore();
  }
});

test('integration v1: read-only runtimes omit mutation tools entirely', async () => {
  const mock = mockDesktop();
  const runtime = new DesktopOrchestratorRuntime(BASE);
  const { client, cleanup } = await connect(runtime, false);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.equal(tools.includes('send_message'), false);
    assert.equal(tools.includes('set_model'), false);
    assert.ok(tools.includes('get_thread_progress'));
  } finally {
    await cleanup();
    runtime.dispose();
    mock.restore();
  }
});

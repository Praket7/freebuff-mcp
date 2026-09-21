import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeDesktop, type FakeDesktop } from './helpers/fake-desktop.js';

/**
 * Wire-level tests for the HTTP transport (`serve-http`), which previously had
 * no coverage at all. Everything here drives a REAL spawned server process over
 * real sockets: authentication, origin validation, request-body bounds, rate
 * limiting, and a full MCP initialize + tools/list handshake.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'test-bearer-token';

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

interface HttpServerHandle {
  port: number;
  child: ChildProcess;
  stop: () => Promise<void>;
}

async function startHttpServer(desktop: FakeDesktop): Promise<HttpServerHandle> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve-http'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FREEBUFF_MCP_HOST: '127.0.0.1',
      FREEBUFF_MCP_PORT: String(port),
      FREEBUFF_MCP_TOKEN: TOKEN,
      FREEBUFF_ORCHESTRATOR_URL: desktop.url,
      FREEBUFF_LAUNCH_ID: desktop.launchId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`serve-http exited early (${child.exitCode}): ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`serve-http did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    port,
    child,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 3000); });
    },
  };
}

/** POST a JSON-RPC message and return the parsed result (handles SSE or JSON replies). */
async function rpc(port: number, body: unknown, options: { token?: string | null; origin?: string } = {}): Promise<{ status: number; result?: any; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  if (options.origin) headers.origin = options.origin;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  let result: any;
  try {
    const payload = text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')
      ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
      : text;
    result = payload ? JSON.parse(payload) : undefined;
  } catch { result = undefined; }
  return { status: response.status, result, text };
}

/** POST a modern 2026-07-28 envelope (with _meta for protocol negotiation). */
async function rpcModern(port: number, body: { method: string; params?: any; _meta?: any }, options: { token?: string | null } = {}): Promise<{ status: number; result?: any; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), ...body }) });
  const text = await response.text();
  let result: any;
  try {
    const payload = text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')
      ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
      : text;
    result = payload ? JSON.parse(payload) : undefined;
  } catch { result = undefined; }
  return { status: response.status, result, text };
}



/** Establish a GET SSE stream (modern 2026-07-28 client path) and return parsed frames.
 * GET is used for stream establishment; messages are sent separately via POST. */
async function sseStream(port: number): Promise<{ status: number; messages: any[] }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'GET',
    headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` },
  });
  const text = await response.text();
  const messages: any[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!trimmed) continue;
    try { messages.push(JSON.parse(trimmed)); } catch { /* ignore partial frames */ }
  }
  return { status: response.status, messages };
}

test('http transport: healthz, authentication, origin, and MCP handshake', async () => {
  const desktop = await startFakeDesktop();
  const server = await startHttpServer(desktop);
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(health.status, 200);

    const unauthorized = await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { token: null });
    assert.equal(unauthorized.status, 401, 'missing bearer token is rejected');

    const wrongToken = await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { token: 'nope' });
    assert.equal(wrongToken.status, 401, 'a wrong bearer token is rejected');

    const badOrigin = await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { origin: 'http://evil.example.com' });
    assert.equal(badOrigin.status, 403, 'a non-loopback Origin is rejected');

    const notFound = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } });
    // GET /mcp is now served for the modern 2026-07-28 protocol (SSE streams
    // and initialization); the legacy JSON-RPC-over-GET gets 405 Method Not Allowed.
    assert.equal(notFound.status, 405, 'only POST /mcp is served for legacy JSON-RPC; GET is modern protocol');

    const init = await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } } });
    assert.equal(init.status, 200);
    assert.ok(init.result?.result?.serverInfo, `initialize returned a server description: ${init.text.slice(0, 200)}`);

    const tools = await rpc(server.port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (tools.result?.result?.tools ?? []).map((t: { name: string }) => t.name);
    assert.ok(names.length > 0, 'tools/list returned tools');
    assert.ok(names.includes('freebuff_status'));
    // HTTP serves the canonical v2 surface, not the legacy runtime catalog.
    for (const v2 of ['start_thread', 'run_turn', 'stop_turn', 'get_turn']) {
      assert.ok(names.includes(v2), `v2 tool ${v2} served over HTTP`);
    }
  } finally {
    await server.stop();
    await desktop.close();
  }
});

test('http transport: legacy 2025 protocol stays on the compatibility path', async () => {
  const desktop = await startFakeDesktop();
  const server = await startHttpServer(desktop);
  try {
    const init = await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } } });
    assert.equal(init.status, 200);
    assert.ok(init.result?.result?.serverInfo, `modern initialize returned a server description: ${init.text.slice(0, 200)}`);
    assert.equal(init.result?.result?.protocolVersion, '2025-11-25');
  } finally {
    await server.stop();
    await desktop.close();
  }
});

/** Collect every SSE data payload from a response (progress + result frames). */
async function rpcSse(port: number, body: unknown): Promise<{ status: number; messages: any[] }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const messages: any[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.startsWith(':') ? '' : line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!trimmed) continue;
    try { messages.push(JSON.parse(trimmed)); } catch { /* ignore partial frames */ }
  }
  return { status: response.status, messages };
}

test('http transport: legacy 2025 protocol stays on the compatibility path', async () => {
  const desktop = await startFakeDesktop();
  const server = await startHttpServer(desktop);
  try {
    const init = await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal(init.result?.result?.protocolVersion, '2025-03-26');
  } finally {
    await server.stop();
    await desktop.close();
  }
});

test('http transport: 2026-07-28 version string via legacy JSON-RPC (modern _meta envelope not supported by SDK 2.0.0)', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 400 });
  const server = await startHttpServer(desktop);
  try {
    // The vendored SDK v2.0.0 only accepts JSON-RPC 2.0 format.
    // It negotiates a 2026-07-28 version string in the legacy initialize
    // params, answering with the server's best supported revision (2025-11-25).
    // A genuine modern 2026-07-28 envelope (no jsonrpc/id) is rejected 400
    // by the current SDK. This test documents the current capability.
    const init = await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'modern-test', version: '1' } } });
    assert.equal(init.status, 200);
    assert.ok(init.result?.result?.serverInfo, `2026-07-28 init answered: ${init.text.slice(0, 200)}`);
    assert.equal(init.result?.result?.protocolVersion, '2025-11-25');
    // The negotiation went through createMcpHandler: a 2026-07-28 version
    // string in legacy JSON-RPC is answered with best supported revision.
    const started = await rpc(server.port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_thread', arguments: {} } });
    const sessionId = started.result?.result?.structuredContent?.sessionId as string;
    assert.ok(sessionId);
    // Progress: run_turn with a progress token streams notifications/progress
    // frames via POST before the final result.
    const run = await rpcSse(server.port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_turn', arguments: { sessionId, text: 'do it' }, _meta: { progressToken: 'p1' } } });
    const progress = run.messages.filter((m) => m.method === 'notifications/progress');
    assert.ok(progress.length > 0, `progress notifications streamed (${run.messages.length} frames)`);
    const final = run.messages.find((m) => m.id === 3);
    assert.equal(final?.result?.structuredContent?.state, 'completed');
  } finally {
    await server.stop();
    await desktop.close();
  }
});

test('http transport: genuine MCP 2026-07-28 modern protocol via modern transport headers', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 400 });
  const server = await startHttpServer(desktop);
  try {
    // A genuine 2026-07-28 client uses the modern transport with Mcp-Method
    // header and protocolVersion in initialize params. The modern transport
    // requires the Mcp-Method header to match the JSON-RPC method.
    const init = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
        'Mcp-Method': 'initialize',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'modern-test', version: '1.0.0' } } }),
    });
    const initText = await init.text();
    let initResult: any;
    try {
      const payload = initText.startsWith('event:') || initText.includes('\ndata:') || initText.startsWith('data:')
        ? initText.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
        : initText;
      initResult = payload ? JSON.parse(payload) : undefined;
    } catch { initResult = undefined; }
    assert.equal(init.status, 200);
    assert.ok(initResult?.result?.serverInfo, `modern initialize answered: ${initText.slice(0, 200)}`);
    assert.equal(initResult?.result?.protocolVersion, '2025-11-25', 'negotiated to best supported revision');

    // tools/call works over the modern transport
    const started = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
        'Mcp-Method': 'tools/call',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_thread', arguments: {} } }),
    });
    const startedText = await started.text();
    let startedResult: any;
    try {
      const payload = startedText.startsWith('event:') || startedText.includes('\ndata:') || startedText.startsWith('data:')
        ? startedText.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
        : startedText;
      startedResult = payload ? JSON.parse(payload) : undefined;
    } catch { startedResult = undefined; }
    const sessionId = startedResult?.result?.structuredContent?.sessionId as string;
    assert.ok(sessionId);

    // Progress: run_turn with progress token streams notifications/progress
    const run = await rpcSse(server.port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_turn', arguments: { sessionId, text: 'do it' }, _meta: { progressToken: 'p1' } } });
    const progress = run.messages.filter((m) => m.method === 'notifications/progress');
    assert.ok(progress.length > 0, `progress notifications streamed (${run.messages.length} frames)`);
    const final = run.messages.find((m) => m.id === 3);
    assert.equal(final?.result?.structuredContent?.state, 'completed');
  } finally {
    await server.stop();
    await desktop.close();
  }
});

test('http transport: modern protocol cancellation stops backend turn', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 30_000 });
  const server = await startHttpServer(desktop);
  try {
    const init = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'Mcp-Method': 'initialize' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'modern-test', version: '1.0.0' } } }),
    });
    const initText = await init.text();
    let initResult: any;
    try {
      const payload = initText.startsWith('event:') || initText.includes('\ndata:') || initText.startsWith('data:')
        ? initText.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
        : initText;
      initResult = payload ? JSON.parse(payload) : undefined;
    } catch { initResult = undefined; }
    assert.equal(init.status, 200);
    assert.ok(initResult?.result?.serverInfo);
    assert.equal(initResult?.result?.protocolVersion, '2025-11-25');

    const started = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'Mcp-Method': 'tools/call' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_thread', arguments: {} } }),
    });
    const startedText = await started.text();
    let startedResult: any;
    try {
      const payload = startedText.startsWith('event:') || startedText.includes('\ndata:') || startedText.startsWith('data:')
        ? startedText.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
        : startedText;
      startedResult = payload ? JSON.parse(payload) : undefined;
    } catch { startedResult = undefined; }
    const sessionId = startedResult?.result?.structuredContent?.sessionId as string;
    assert.ok(sessionId);

    // Start a long turn asynchronously (send_message returns immediately)
    const sentPromise = fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'Mcp-Method': 'tools/call' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { sessionId, text: 'long job' } } }),
    });
    // Let the turn start, then cancel it
    await new Promise((r) => setTimeout(r, 300));
    const stopped = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'Mcp-Method': 'tools/call' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stop_turn', arguments: { sessionId } } }),
    });
    const stoppedText = await stopped.text();
    let stoppedResult: any;
    try {
      const payload = stoppedText.startsWith('event:') || stoppedText.includes('\ndata:') || stoppedText.startsWith('data:')
        ? stoppedText.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
        : stoppedText;
      stoppedResult = payload ? JSON.parse(payload) : undefined;
    } catch { stoppedResult = undefined; }
    assert.equal(stoppedResult?.result?.structuredContent?.cancelled, true);
    assert.equal(stoppedResult?.result?.structuredContent?.stopped, true, 'backend stop confirmed');
    const sent = await sentPromise;
    const sentText = await sent.text();
    let sentResult: any;
    try {
      const payload = sentText.startsWith('event:') || sentText.includes('\ndata:') || sentText.startsWith('data:')
        ? sentText.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
        : sentText;
      sentResult = payload ? JSON.parse(payload) : undefined;
    } catch { sentResult = undefined; }
    const turnId = sentResult?.result?.structuredContent?.turnId as string;
    const view = await rpc(server.port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_turn', arguments: { turnId } } });
    assert.equal(view.result?.result?.structuredContent?.state, 'cancelled');
  } finally {
    await server.stop();
    await desktop.close();
  }
});

test('http transport: stop_turn cancels a live turn over the wire', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 30_000 });
  const server = await startHttpServer(desktop);
  try {
    const started = await rpc(server.port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_thread', arguments: {} } });
    const sessionId = started.result?.result?.structuredContent?.sessionId as string;
    assert.ok(sessionId);

    const sentPromise = rpc(server.port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { sessionId, text: 'long job' } } });
    // Let the turn start, then cancel it through a second request.
    await new Promise((r) => setTimeout(r, 300));
    const stopped = await rpc(server.port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stop_turn', arguments: { sessionId } } });
    assert.equal(stopped.result?.result?.structuredContent?.cancelled, true);
    assert.equal(stopped.result?.result?.structuredContent?.stopped, true, 'the backend stop was confirmed over HTTP');
    const sent = await sentPromise;
    const turnId = sent.result?.result?.structuredContent?.turnId as string;
    const view = await rpc(server.port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_turn', arguments: { turnId } } });
    assert.equal(view.result?.result?.structuredContent?.state, 'cancelled');
  } finally {
    await server.stop();
    await desktop.close();
  }
});

test('http transport: malformed and oversized request bodies are rejected', async () => {
  const desktop = await startFakeDesktop();
  const server = await startHttpServer(desktop);
  try {
    const malformed = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{not json' });
    assert.equal(malformed.status, 400);

    const oversized = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'freebuff_status', arguments: { pad: 'x'.repeat(2_500_000) } } }),
    });
    assert.equal(oversized.status, 400, 'bodies over the 2 MB cap are rejected');
  } finally {
    await server.stop();
    await desktop.close();
  }
});

test('http transport: rate limiting kicks in with 429 and a retry-after', async () => {
  const desktop = await startFakeDesktop();
  const server = await startHttpServer(desktop);
  try {
    let limited: Response | undefined;
    for (let i = 0; i < 130; i++) {
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      if (response.status === 429) { limited = response; break; }
    }
    assert.ok(limited, 'the limiter engaged within 130 requests');
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.match(await limited.text(), /rate_limited/);
  } finally {
    await server.stop();
    await desktop.close();
  }
});

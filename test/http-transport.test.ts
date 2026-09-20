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
    assert.equal(notFound.status, 404, 'only POST /mcp is served');

    const init = await rpc(server.port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } } });
    assert.equal(init.status, 200);
    assert.ok(init.result?.result?.serverInfo, `initialize returned a server description: ${init.text.slice(0, 200)}`);

    const tools = await rpc(server.port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (tools.result?.result?.tools ?? []).map((t: { name: string }) => t.name);
    assert.ok(names.length > 0, 'tools/list returned tools');
    assert.ok(names.includes('freebuff_status'));
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

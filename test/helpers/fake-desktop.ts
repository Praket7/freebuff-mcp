import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An in-process fake of the Freebuff Desktop orchestrator's HTTP API.
 *
 * Every route, payload shape, and status code here mirrors the REAL Desktop
 * (verified against a live installation). CI has no Desktop installed, so this
 * server is what lets the bridge be tested against the actual HTTP contract
 * instead of against `fetch` stubs.
 *
 * Real shapes modelled:
 *  - `GET  /healthz`                     -> { ok, launchId, pid, port } (launch id required)
 *  - `GET  /api/projects`                -> { projects: [{ path, threads: [...] }] }
 *  - `GET  /api/thread/:id`              -> { thread, messages, items }
 *  - `POST /api/threads`                 -> the created thread object
 *  - `POST /api/thread/:id/message`      -> { ok, itemId } (turn continues asynchronously)
 *  - `POST /api/thread/:id/stop`         -> { ok: true }
 *  - `POST /api/thread/:id/agent|effort` -> { ok: true, ... }
 *  - `GET  /api/thread/:id/changes`      -> { scope, branch, files, totals }
 *  - `GET  /api/thread/:id/changes/diff` -> { patch } | 400 { error }
 *  - `GET  /api/events`                  -> SSE `{"type":"state","snapshot":{threads:[...]}}`
 */
export interface FakeDesktopCall {
  method: string;
  path: string;
  body?: unknown;
  launchId?: string;
}

export interface FakeDesktop {
  url: string;
  launchId: string;
  projectPath: string;
  threadId: string;
  calls: FakeDesktopCall[];
  /** Live thread records (mutable, so tests can drive turn state). */
  threads: Map<string, Record<string, unknown>>;
  /** Attached SSE clients (for assertions about stream lifecycle). */
  sseClients: number;
  setChangedFiles(threadId: string, files: Array<{ path: string; adds: number; dels: number }>): void;
  /** Drop every attached SSE client, as a network blip or Desktop restart would. */
  dropSseClients(): void;
  close(): Promise<void>;
}

export interface FakeDesktopOptions {
  /** How long a turn stays `running` before it settles. */
  turnDelayMs?: number;
  /** Record the turn as failed (`lastTurnOutcome: "error"`). */
  failTurn?: boolean;
  /** Launch id the Desktop expects on writes. */
  launchId?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export async function startFakeDesktop(options: FakeDesktopOptions = {}): Promise<FakeDesktop> {
  const launchId = options.launchId ?? 'fake-launch-id';
  const turnDelayMs = options.turnDelayMs ?? 0;
  const projectPath = '/tmp/fake-project';
  const threadId = '11111111-2222-3333-4444-555555555555';
  const calls: FakeDesktopCall[] = [];
  const changedFiles = new Map<string, Array<{ path: string; adds: number; dels: number }>>();
  const sseResponses = new Set<ServerResponse>();
  const timers = new Set<NodeJS.Timeout>();

  const now = (): number => Date.now();
  const threads = new Map<string, Record<string, unknown>>([
    [threadId, {
      id: threadId,
      projectId: projectPath,
      projectPath,
      title: 'Fixture thread',
      status: 'open',
      harnessId: 'codebuff',
      model: 'fixture-model',
      turnState: 'idle',
      lastTurnOutcome: 'closed',
      lastTurnFinishedAt: now() - 1000,
      stopping: false,
      createdAt: now() - 10_000,
      updatedAt: now(),
    }],
  ]);
  const messages = new Map<string, unknown[]>([
    [threadId, [
      { role: 'user', parts: [{ type: 'text', text: 'do the thing' }], attachments: [{ path: '/tmp/spec.md', name: 'spec.md' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
    ]],
  ]);

  const sendSse = (): void => {
    const payload = JSON.stringify({
      type: 'state',
      snapshot: { project: { id: projectPath, rootPath: projectPath }, threads: [...threads.values()] },
    });
    for (const response of sseResponses) {
      try { response.write(`data: ${payload}\n\n`); } catch { sseResponses.delete(response); }
    }
  };

  const json = (response: ServerResponse, body: unknown, status = 200): void => {
    response.writeHead(status, JSON_HEADERS);
    response.end(JSON.stringify(body));
  };

  const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  };

  /** A turn: expose `running`, then settle to `idle` with the configured outcome. */
  const runTurn = (id: string): void => {
    const thread = threads.get(id);
    if (!thread) return;
    thread.turnState = 'running';
    sendSse();
    const timer = setTimeout(() => {
      timers.delete(timer);
      const current = threads.get(id);
      if (!current || current.turnState !== 'running') return; // stopped/cancelled already
      current.turnState = 'idle';
      current.lastTurnFinishedAt = now();
      current.lastTurnOutcome = options.failTurn ? 'error' : 'closed';
      const list = messages.get(id) ?? [];
      list.push({ role: 'assistant', parts: [{ type: 'text', text: options.failTurn ? 'it broke' : 'turn finished' }] });
      messages.set(id, list);
      sendSse();
    }, turnDelayMs);
    timers.add(timer);
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = (request.method ?? 'GET').toUpperCase();
      const body = method === 'POST' || method === 'PUT' ? await readBody(request) : undefined;
      const headerLaunch = request.headers['x-freebuff-launch-id'];
      calls.push({ method, path: path + url.search, ...(body !== undefined ? { body } : {}), ...(typeof headerLaunch === 'string' ? { launchId: headerLaunch } : {}) });

      if (path === '/healthz') {
        if (typeof headerLaunch !== 'string' || headerLaunch !== launchId) return json(response, { error: 'unauthorized' }, 401);
        return json(response, { ok: true, launchId, pid: process.pid, port: (server.address() as AddressInfo).port });
      }

      if (path === '/api/projects') {
        return json(response, { projects: [{ path: projectPath, threads: [...threads.values()] }] });
      }

      if (path === '/api/threads' && method === 'POST') {
        const id = `created-${threads.size + 1}`;
        const created = { id, projectId: projectPath, projectPath, title: 'New thread', status: 'open', harnessId: 'codebuff', model: 'fixture-model', turnState: 'idle', draft: true, createdAt: now(), updatedAt: now() };
        threads.set(id, created);
        messages.set(id, []);
        sendSse();
        return json(response, created);
      }

      const threadMatch = /^\/api\/thread\/([^/]+)(\/.*)?$/.exec(path);
      if (threadMatch) {
        const id = decodeURIComponent(threadMatch[1]!);
        const suffix = threadMatch[2] ?? '';
        const thread = threads.get(id);
        if (!thread) return json(response, { error: 'not found' }, 404);

        if (suffix === '' && method === 'GET') return json(response, { thread, messages: messages.get(id) ?? [], items: [] });
        if (suffix === '/changes' && method === 'GET') {
          const files = changedFiles.get(id) ?? [];
          return json(response, { scope: url.searchParams.get('scope') ?? 'all', branch: null, files, totals: { files: files.length, adds: files.reduce((n, f) => n + f.adds, 0), dels: files.reduce((n, f) => n + f.dels, 0) } });
        }
        if (suffix === '/changes/diff' && method === 'GET') {
          const file = url.searchParams.get('file') ?? '';
          if (!file || file.startsWith('/') || file.includes('..')) return json(response, { error: 'invalid path' }, 400);
          const known = (changedFiles.get(id) ?? []).find((f) => f.path === file);
          if (!known) return json(response, { patch: '' });
          return json(response, { patch: `diff --git a/${file} b/${file}\n@@ -1 +1,2 @@\n-old line\n+new line\n` });
        }

        // Action routes: POST /api/thread/:id/<action>
        if (method === 'POST' && suffix === '/message') {
          const text = typeof body?.text === 'string' ? body.text : '';
          if (!text.trim()) return json(response, { error: 'text or attachments required' }, 400);
          runTurn(id);
          return json(response, { ok: true, itemId: 'item-1' });
        }
        if (method === 'POST' && suffix === '/stop') {
          thread.turnState = 'idle';
          thread.lastTurnFinishedAt = now();
          sendSse();
          return json(response, { ok: true });
        }
        if (method === 'POST' && (suffix === '/agent' || suffix === '/effort')) return json(response, { ok: true, model: thread.model });
        return json(response, { error: 'unknown action' }, 400);
      }

      if (path === '/api/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.write(`retry: 250\n\n`);
        sseResponses.add(response);
        sendSse();
        request.on('close', () => sseResponses.delete(response));
        return undefined;
      }

      return json(response, { error: 'not found' }, 404);
    })().catch(() => { try { json(response, { error: 'internal' }, 500); } catch { /* already sent */ } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    launchId,
    projectPath,
    threadId,
    calls,
    threads,
    get sseClients() { return sseResponses.size; },
    setChangedFiles(id, files) { changedFiles.set(id, files); },
    dropSseClients() {
      for (const response of sseResponses) { try { response.end(); } catch { /* ignore */ } }
      sseResponses.clear();
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const response of sseResponses) { try { response.end(); } catch { /* ignore */ } }
      sseResponses.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

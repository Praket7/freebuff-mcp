import assert from 'node:assert/strict';
import test from 'node:test';
import { createV2ServerFromAdapter, V2Adapter } from '../src/mcp-v2.js';
import { CompositeBackend } from '../src/backends/backend.js';
import { SessionManager } from '../src/bridge/session-manager.js';
import { TurnManager } from '../src/bridge/turn-manager.js';
import { BackendTurnResult, FreebuffBackend } from '../src/bridge/types.js';

/**
 * Item 11: one semantic contract across the supported surfaces (MCP v2, HTTP,
 * ACP all share this bridge; serve-v1 is frozen and excluded).
 *
 * Cancellation confirms the backend stop, unproven work reports waiting, and
 * failed stops are loud — asserted here end-to-end through the v2 tool
 * handlers, which is exactly what HTTP serves.
 */

function toolOf(server: unknown, name: string): { handler: (args: unknown, ctx: unknown) => Promise<{ structuredContent?: Record<string, unknown> }> } {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, ctx: unknown) => Promise<{ structuredContent?: Record<string, unknown> }> }> })._registeredTools;
  const tool = tools[name];
  assert.ok(tool, `${name} registered`);
  return tool!;
}

const ctx = { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => undefined } };

function adapterFor(backend: FreebuffBackend): V2Adapter {
  const sessions = new SessionManager(backend);
  return { backend: backend as unknown as CompositeBackend, sessions, turns: new TurnManager(sessions) };
}

function hangingBackend(stops: string[]): FreebuffBackend {
  return {
    kind: 'desktop',
    probe: async () => ({ backend: 'desktop', connection: 'connected_writable', authorization: 'write_authorized', liveProgress: 'connected', canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    createSession: async ({ cwd }: { cwd: string }) => ({ id: 'h1', backend: 'desktop' as const, backendSessionId: 'thread-1', cwd }),
    sendMessage: async ({ signal }: { signal?: AbortSignal }): Promise<BackendTurnResult> => {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { state: 'cancelled' as const, result: {} };
    },
    stop: async () => { stops.push('stop'); },
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
}

test('contract: stop_turn confirms the backend stop and the turn reports cancelled', async () => {
  const stops: string[] = [];
  const adapter = adapterFor(hangingBackend(stops));
  const server = createV2ServerFromAdapter(adapter);
  const started = (await toolOf(server, 'start_thread').handler({ cwd: '/tmp/p' }, ctx)).structuredContent as { sessionId: string };
  const sent = (await toolOf(server, 'send_message').handler({ sessionId: started.sessionId, text: 'long' }, ctx)).structuredContent as { turnId: string };
  await new Promise((r) => setTimeout(r, 10));
  const stopped = (await toolOf(server, 'stop_turn').handler({ sessionId: started.sessionId }, ctx)).structuredContent as { cancelled: boolean; stopped: boolean };
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.stopped, true, 'cancellation is confirmed by the backend, not just the local wait');
  assert.deepEqual(stops, ['stop']);
  const turn = (await toolOf(server, 'get_turn').handler({ turnId: sent.turnId }, undefined)).structuredContent as { state: string };
  assert.equal(turn.state, 'cancelled');
});

test('contract: unproven work reports waiting, never completed', async () => {
  const backend: FreebuffBackend = {
    kind: 'desktop',
    probe: async () => ({ backend: 'desktop', connection: 'connected_writable', authorization: 'write_authorized', liveProgress: 'connected', canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    createSession: async ({ cwd }: { cwd: string }) => ({ id: 'h1', backend: 'desktop' as const, backendSessionId: 'thread-1', cwd }),
    sendMessage: async () => ({ state: 'waiting_for_user' as const, error: 'Turn outcome unconfirmed.' }),
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
  const adapter = adapterFor(backend);
  const server = createV2ServerFromAdapter(adapter);
  const started = (await toolOf(server, 'start_thread').handler({ cwd: '/tmp/p' }, ctx)).structuredContent as { sessionId: string };
  const ran = (await toolOf(server, 'run_turn').handler({ sessionId: started.sessionId, text: 'maybe' }, ctx)).structuredContent as { state: string };
  assert.equal(ran.state, 'waiting_for_user');
});

test('contract: a failed backend stop is loud at the tool surface', async () => {
  const backend: FreebuffBackend = {
    kind: 'desktop',
    probe: async () => ({ backend: 'desktop', connection: 'connected_writable', authorization: 'write_authorized', liveProgress: 'connected', canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    createSession: async ({ cwd }: { cwd: string }) => ({ id: 'h1', backend: 'desktop' as const, backendSessionId: 'thread-1', cwd }),
    sendMessage: async ({ signal }: { signal?: AbortSignal }): Promise<BackendTurnResult> => {
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { state: 'completed' as const, result: {} };
    },
    stop: async () => { throw new Error('stop refused'); },
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
  const adapter = adapterFor(backend);
  const server = createV2ServerFromAdapter(adapter);
  const started = (await toolOf(server, 'start_thread').handler({ cwd: '/tmp/p' }, ctx)).structuredContent as { sessionId: string };
  await toolOf(server, 'send_message').handler({ sessionId: started.sessionId, text: 'long' }, ctx);
  await new Promise((r) => setTimeout(r, 10));
  const stopped = (await toolOf(server, 'stop_turn').handler({ sessionId: started.sessionId }, ctx)).structuredContent as { stopped: boolean; stopError?: string; note?: string };
  assert.equal(stopped.stopped, false);
  assert.match(stopped.stopError ?? '', /stop refused/);
  assert.match(stopped.note ?? '', /may still be running/);
});

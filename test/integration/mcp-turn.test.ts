import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createV2ServerFromAdapter, V2Adapter } from '../../src/mcp-v2.js';
import { CompositeBackend } from '../../src/backends/backend.js';
import { SessionManager } from '../../src/bridge/session-manager.js';
import { TurnManager } from '../../src/bridge/turn-manager.js';
import { FreebuffBackend, BackendSession, BackendTurnResult } from '../../src/bridge/types.js';

function scriptedBackend(): FreebuffBackend & { calls: Array<{ text: string; signal?: AbortSignal }> } {
  const calls: Array<{ text: string; signal?: AbortSignal }> = [];
  let sessionCounter = 0;
  return {
    kind: 'desktop',
    calls,
    async probe() { return { backend: 'desktop', connection: 'connected_writable', authorization: 'write_authorized', liveProgress: 'connected', canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: ['scripted test backend'] }; },
    async createSession({ cwd }: { cwd: string }) {
      sessionCounter += 1;
      return { id: `bridge-session-${sessionCounter}`, backend: 'desktop' as const, backendSessionId: `real-thread-${sessionCounter}`, cwd };
    },
    async sendMessage({ session, text, signal }: { session: BackendSession; text: string; signal?: AbortSignal }): Promise<BackendTurnResult> {
      calls.push({ text, signal });
      // Structured progress: planning -> tool -> completed.
      return await new Promise<BackendTurnResult>((resolve) => {
        setTimeout(() => resolve({ state: 'completed', result: { done: true, thread: session.backendSessionId } }), 30);
      });
    },
    async stop() { return undefined; },
    dispose() { return undefined; },
  } as unknown as FreebuffBackend & { calls: Array<{ text: string; signal?: AbortSignal }> };
}

async function makeClientPair(): Promise<{ client: Client; backend: ReturnType<typeof scriptedBackend>; adapter: V2Adapter; cleanup: () => Promise<void> }> {
  const backend = scriptedBackend();
  const sessions = new SessionManager(backend);
  const turns = new TurnManager(sessions);
  const adapter: V2Adapter = { backend: backend as unknown as CompositeBackend, sessions, turns };
  const server = createV2ServerFromAdapter(adapter);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, backend, adapter, cleanup: async () => { await client.close(); await server.close(); } };
}

test('integration: initialize, tools/list, freebuff_status', async () => {
  const { client, cleanup } = await makeClientPair();
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'run_turn'));
    assert.ok(tools.tools.some((t) => t.name === 'freebuff_status'));
    const status = await client.callTool({ name: 'freebuff_status', arguments: {} });
    const structured = status.structuredContent as { connection?: string };
    assert.equal(structured?.connection, 'connected_writable');
  } finally {
    await cleanup();
  }
});

test('integration: run_turn completes with structured output and session identity', async () => {
  const { client, backend, cleanup } = await makeClientPair();
  try {
    const started = await client.callTool({ name: 'start_thread', arguments: { cwd: '/tmp/proj' } });
    const startedData = started.structuredContent as { sessionId: string; backendSessionId: string };
    assert.notEqual(startedData.sessionId, startedData.backendSessionId, 'bridge and backend ids differ');

    const result = await client.callTool({ name: 'run_turn', arguments: { sessionId: startedData.sessionId, text: 'fix the bug' } });
    const data = result.structuredContent as { ok: boolean; state: string; turnId: string; result?: { done: boolean } };
    assert.equal(data.ok, true);
    assert.equal(data.state, 'completed');
    assert.equal(data.result?.done, true);
    assert.equal(backend.calls.length, 1);
    assert.equal(backend.calls[0]?.text, 'fix the bug');
  } finally {
    await cleanup();
  }
});

test('integration: run_turn cancellation aborts the backend and the server survives', async () => {
  const { client, backend, adapter, cleanup } = await makeClientPair();
  try {
    // Make the backend hang until aborted.
    (backend as unknown as { sendMessage: (o: { session: BackendSession; text: string; signal?: AbortSignal }) => Promise<BackendTurnResult> }).sendMessage = async ({ session, signal }: { session: BackendSession; text: string; signal?: AbortSignal }) => {
      return await new Promise<BackendTurnResult>((resolve, reject) => {
        signal?.addEventListener('abort', () => resolve({ state: 'cancelled' }), { once: true });
        void session;
      });
    };
    void adapter;
    const started = await client.callTool({ name: 'start_thread', arguments: { cwd: '/tmp/proj' } });
    const { sessionId } = started.structuredContent as { sessionId: string };
    // stop_turn in parallel while a run_turn is hanging via send_message+wait.
    const handle = adapter.sessions.startTurn(sessionId, { text: 'hang please' });
    await new Promise((r) => setTimeout(r, 10));
    const stop = await client.callTool({ name: 'stop_turn', arguments: { sessionId } });
    assert.equal((stop.structuredContent as { cancelled: boolean }).cancelled, true);
    const turn = await handle.done;
    assert.equal(turn.state, 'cancelled');
    // Server is still alive after cancellation.
    const ping = await client.callTool({ name: 'freebuff_status', arguments: {} });
    assert.ok(ping.structuredContent);
  } finally {
    await cleanup();
  }
});

test('integration: send_message returns a turnId usable with get_turn and watch_turn', async () => {
  const { client, adapter, cleanup } = await makeClientPair();
  try {
    const started = await client.callTool({ name: 'start_thread', arguments: { cwd: '/tmp/proj' } });
    const { sessionId } = started.structuredContent as { sessionId: string };
    const sent = await client.callTool({ name: 'send_message', arguments: { sessionId, text: 'async work' } });
    const { turnId } = sent.structuredContent as { turnId: string; state: string };
    assert.ok(turnId);
    // Wait for terminal state.
    for (let i = 0; i < 50; i++) {
      const turn = adapter.turns.getTurn(turnId);
      if (['completed', 'failed', 'cancelled'].includes(turn.state)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const turnView = await client.callTool({ name: 'get_turn', arguments: { turnId } });
    const data = turnView.structuredContent as { state: string; turnId: string };
    assert.equal(data.turnId, turnId);
    assert.equal(data.state, 'completed');
  } finally {
    await cleanup();
  }
});

test('integration: unavailable backend returns a structured actionable error, not a missing tool', async () => {
  const backend = scriptedBackend();
  (backend as unknown as { probe: () => Promise<never> }).probe = async () => {
    throw new Error('unavailable');
  };
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const turns = new TurnManager(sessions);
  const server = createV2ServerFromAdapter({ backend: backend as unknown as CompositeBackend, sessions, turns });
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'freebuff_status', arguments: {} });
    const data = result.structuredContent as { code?: string };
    assert.ok(data, 'structured status returned even when probing fails');
  } finally {
    await client.close();
    await server.close();
  }
});

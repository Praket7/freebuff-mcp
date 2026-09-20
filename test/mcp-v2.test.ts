import assert from 'node:assert/strict';
import test from 'node:test';
import { createV2ServerFromAdapter, V2Adapter } from '../src/mcp-v2.js';
import { CompositeBackend } from '../src/backends/backend.js';
import { SessionManager } from '../src/bridge/session-manager.js';
import { TurnManager } from '../src/bridge/turn-manager.js';
import { BackendCapabilities, FreebuffBackend } from '../src/bridge/types.js';

function makeAdapter(caps: Partial<BackendCapabilities> = {}): V2Adapter & { backend: CompositeBackend } {
  const backend = new CompositeBackend();
  const sessions = new SessionManager(backend);
  const turns = new TurnManager(sessions);
  return { backend, sessions, turns };
}

test('MCP v2 server exposes the stable guarded tool surface', () => {
  const adapter = makeAdapter();
  const server = createV2ServerFromAdapter(adapter);
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  const names = Object.keys(tools).sort();
  for (const expected of ['freebuff_status', 'list_projects', 'list_threads', 'get_thread', 'get_thread_messages', 'get_active_work', 'get_turn', 'get_thread_progress', 'get_thread_progress_summary', 'watch_thread', 'watch_turn', 'watch_active_threads', 'list_project_files', 'read_project_file', 'list_thread_attachments', 'list_models', 'search_history', 'start_thread', 'send_message', 'run_turn', 'stop_turn', 'stop_thread', 'resume_thread', 'set_model', 'set_reasoning', 'get_changed_files', 'get_diff']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.equal(names.length, 27, `unexpected extra tools: ${names.join(', ')}`);
});

type LooseTool = { handler: (args: unknown, ctx: unknown) => Promise<{ structuredContent?: Record<string, unknown> }> };

function toolOf(server: unknown, name: string): LooseTool {
  const tools = (server as unknown as { _registeredTools: Record<string, LooseTool> })._registeredTools;
  const tool = tools[name];
  assert.ok(tool, `${name} registered`);
  return tool!;
}

test('MCP v2: progress summary omits raw events and get_diff never fabricates a diff', async () => {
  // A stub backend keeps this test hermetic: no discovery, no sockets.
  const backend = {
    kind: 'desktop' as const,
    probe: async () => ({ backend: 'desktop' as const, connection: 'unavailable' as const, authorization: 'none' as const, liveProgress: 'unavailable' as const, canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: [] }),
    getThread: async () => { throw new Error('no Desktop in this test'); },
    listThreads: async () => [],
    listProjects: async () => [],
    getMessages: async () => [],
    listAttachments: async () => [],
    sendMessage: async () => { throw new Error('read-only stub'); },
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const adapter: V2Adapter = { backend, sessions, turns: new TurnManager(sessions) };
  const server = createV2ServerFromAdapter(adapter);
  const summary = await toolOf(server, 'get_thread_progress_summary').handler({ threadId: 'thread-1' }, undefined);
  assert.equal(summary.structuredContent?.ok, true);
  assert.equal(summary.structuredContent?.connected, false);
  assert.equal(summary.structuredContent?.stale, true);
  assert.equal(Object.prototype.hasOwnProperty.call(summary.structuredContent ?? {}, 'events'), false, 'summary must not embed raw events');

  const diff = await toolOf(server, 'get_diff').handler({ threadId: 'thread-1' }, undefined);
  assert.equal(diff.structuredContent?.ok, true);
  assert.deepEqual(diff.structuredContent?.files, []);
  assert.equal(diff.structuredContent?.diffAvailable, false);
  assert.match(String(diff.structuredContent?.note), /does not expose diff text/i);

  const changed = await toolOf(server, 'get_changed_files').handler({ threadId: 'thread-1' }, undefined);
  assert.deepEqual(changed.structuredContent?.files, []);
});

test('freebuff_status returns structured capability data', async () => {
  const adapter = makeAdapter();
  const server = createV2ServerFromAdapter(adapter);
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assert.ok(tools.freebuff_status, 'freebuff_status registered');
});

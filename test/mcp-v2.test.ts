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
  for (const expected of ['freebuff_status', 'list_projects', 'list_threads', 'get_thread', 'get_thread_messages', 'get_active_work', 'get_turn', 'get_thread_progress', 'get_thread_progress_summary', 'watch_thread', 'watch_turn', 'watch_active_threads', 'list_project_files', 'read_project_file', 'list_thread_attachments', 'list_models', 'search_history', 'start_thread', 'send_message', 'run_turn', 'stop_turn', 'stop_thread', 'resume_thread', 'set_model', 'set_reasoning', 'get_changed_files', 'get_diff', 'get_changes']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.equal(names.length, 28, `unexpected extra tools: ${names.join(', ')}`);
});

test('MCP v2: resume_thread uses the Desktop resume route instead of submitting /resume as a prompt', async () => {
  const calls: string[] = [];
  const backend = {
    kind: 'desktop' as const,
    desktop: {
      resume: async (session: { backendSessionId?: string }) => { calls.push(`resume:${session.backendSessionId}`); return { ok: true }; },
    },
    probe: async () => ({ backend: 'desktop' as const, connection: 'connected_writable' as const, authorization: 'write_authorized' as const, liveProgress: 'connected' as const, canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    sendMessage: async () => { calls.push('sendMessage'); return { state: 'completed' as const }; },
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const adapter: V2Adapter = { backend, sessions, turns: new TurnManager(sessions) };
  const server = createV2ServerFromAdapter(adapter);
  const session = sessions.registerExisting({ backendSessionId: 'thread-abc', cwd: '/tmp/project' });

  const result = await toolOf(server, 'resume_thread').handler({ sessionId: session.id, threadId: 'thread-abc' }, {
    mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => undefined },
  });
  assert.equal(result.structuredContent?.ok, true);
  assert.deepEqual(calls, ['resume:thread-abc'], 'the Desktop resume route is used and no prompt is submitted');
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
  assert.equal('diff' in (diff.structuredContent ?? {}), false, 'never fabricates a diff');

  const changed = await toolOf(server, 'get_changed_files').handler({ threadId: 'thread-1' }, undefined);
  assert.deepEqual(changed.structuredContent?.files, []);

  // A Desktop that lacks the route must say so with a structured code.
  const changes = await toolOf(server, 'get_changes').handler({ threadId: 'thread-1' }, undefined);
  assert.equal(changes.structuredContent?.ok, false);
  assert.equal(changes.structuredContent?.code, 'FREEBUFF_DESKTOP_API_INCOMPATIBLE');
});

/** Fixtures match the real Desktop routes (/api/thread/:id/changes[/diff]). */
function desktopChangesAdapter(): V2Adapter {
  const backend = {
    kind: 'desktop' as const,
    probe: async () => ({ backend: 'desktop' as const, connection: 'connected_writable' as const, authorization: 'write_authorized' as const, liveProgress: 'connected' as const, canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    getThread: async () => { throw new Error('no Desktop in this test'); },
    dispose: () => undefined,
    desktop: {
      getChanges: async (_id: string, scope = 'all') => ({ scope, branch: null, files: [{ path: 'src/a.ts', adds: 3, dels: 1, untracked: false }], totals: { files: 1, adds: 3, dels: 1 } }),
      getDiff: async (_id: string, file: string) => ({ patch: `diff --git a/${file} b/${file}\n@@ -1 +1,3 @@\n-old\n+new\n+more\n` }),
    },
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  return { backend, sessions, turns: new TurnManager(sessions) };
}

test('MCP v2: get_diff reports real Desktop patches instead of inventing them', async () => {
  const server = createV2ServerFromAdapter(desktopChangesAdapter());
  const diff = await toolOf(server, 'get_diff').handler({ threadId: 'thread-1' }, undefined);
  const files = diff.structuredContent?.files as Array<Record<string, unknown>>;
  assert.equal(diff.structuredContent?.diffAvailable, true);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, 'src/a.ts');
  assert.equal(files[0]?.adds, 3);
  assert.equal(files[0]?.dels, 1);
  assert.match(String(files[0]?.diff), /^diff --git a\/src\/a\.ts/);
  assert.deepEqual(diff.structuredContent?.totals, { files: 1, adds: 3, dels: 1 });

  const changes = await toolOf(server, 'get_changes').handler({ threadId: 'thread-1' }, undefined);
  assert.equal(changes.structuredContent?.ok, true);
  assert.deepEqual(changes.structuredContent?.totals, { files: 1, adds: 3, dels: 1 });
});

test('MCP v2: binary, too-large, and failed diffs are surfaced instead of masked as text', async () => {
  for (const [result, expectedKey] of [[{ binary: true }, 'binary'], [{ tooLarge: true }, 'tooLarge'], [{ error: 'this folder is not a git repository' }, 'error']] as const) {
    const backend = {
      kind: 'desktop' as const,
      probe: async () => ({ backend: 'desktop' as const, connection: 'connected_writable' as const, authorization: 'write_authorized' as const, liveProgress: 'connected' as const, canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
      getThread: async () => { throw new Error('no Desktop in this test'); },
      dispose: () => undefined,
      desktop: {
        getChanges: async (_id: string, scope = 'all') => ({ scope, files: [{ path: 'src/b.bin', adds: 0, dels: 0 }], totals: { files: 1, adds: 0, dels: 0 } }),
        getDiff: async () => result,
      },
    } as unknown as CompositeBackend;
    const sessions = new SessionManager(backend as unknown as FreebuffBackend);
    const server = createV2ServerFromAdapter({ backend, sessions, turns: new TurnManager(sessions) });
    const diff = await toolOf(server, 'get_diff').handler({ threadId: 'thread-1' }, undefined);
    assert.equal(diff.structuredContent?.ok, true);
    assert.equal(diff.structuredContent?.diffAvailable, false, 'no diff text is fabricated');
    const files = diff.structuredContent?.files as Array<Record<string, unknown>>;
    assert.equal(files[0]?.[expectedKey] !== undefined, true, `expected the ${expectedKey} signal`);
    assert.equal('diff' in (files[0] ?? {}), false);
  }
});

test('freebuff_status returns structured capability data', async () => {
  const adapter = makeAdapter();
  const server = createV2ServerFromAdapter(adapter);
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assert.ok(tools.freebuff_status, 'freebuff_status registered');
});

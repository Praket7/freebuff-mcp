import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createV2ServerFromAdapter, V2Adapter } from '../src/mcp-v2.js';
import { CompositeBackend } from '../src/backends/backend.js';
import { DesktopBackend } from '../src/backends/desktop-backend.js';
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
  for (const expected of ['freebuff_status', 'get_freebuff_status', 'list_projects', 'list_threads', 'list_threads_page', 'get_thread', 'get_thread_settings', 'get_thread_messages', 'get_thread_messages_page', 'get_active_work', 'get_turn', 'get_thread_progress', 'get_thread_progress_summary', 'watch_thread', 'watch_turn', 'watch_active_threads', 'list_project_files', 'read_project_file', 'get_project_file', 'list_thread_attachments', 'list_models', 'get_model_catalog_status', 'search_history', 'search_threads', 'search_threads_page', 'search_thread_messages', 'start_thread', 'create_thread', 'send_message', 'run_turn', 'stop_turn', 'stop_thread', 'resume_thread', 'set_model', 'set_reasoning', 'get_changed_files', 'get_diff', 'get_changes']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.equal(names.length, 38, `unexpected extra tools: ${names.join(', ')}`);
  const insertionOrder = Object.keys((createV2ServerFromAdapter(makeAdapter()) as any)._registeredTools);
  assert.deepEqual(insertionOrder, Object.keys((createV2ServerFromAdapter(makeAdapter()) as any)._registeredTools), 'tool registration order stays deterministic for clients that cache tool definitions');
});

test('canonical search tools search visible threads and bounded messages accurately', async () => {
  const backend = {
    kind: 'desktop' as const,
    probe: async () => ({ backend: 'desktop' as const, connection: 'connected_read_only' as const, authorization: 'none' as const, liveProgress: 'unavailable' as const, canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: [] }),
    listThreads: async () => [{ id: 'thread-a', title: 'Build parser' }, { id: 'thread-b', title: 'Release notes' }],
    getMessages: async () => [{ role: 'user', content: 'Please fix the parser' }, { role: 'assistant', content: 'Parser fixed' }, { role: 'user', content: 'Unrelated' }],
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const server = createV2ServerFromAdapter({ backend, sessions, turns: new TurnManager(sessions) });
  const ctx = { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => undefined } };

  const threads = await toolOf(server, 'search_threads').handler({ query: 'PARSER' }, ctx);
  assert.deepEqual(threads.structuredContent, [{ id: 'thread-a', title: 'Build parser' }]);
  const messages = await toolOf(server, 'search_thread_messages').handler({ threadId: 'thread-a', query: 'parser' }, ctx);
  assert.equal((messages.structuredContent?.matches as unknown[]).length, 2);
  assert.deepEqual((messages.structuredContent?.matches as Array<Record<string, unknown>>).map((match) => match.index), [0, 1]);
  assert.equal((messages.structuredContent?.matches as Array<Record<string, unknown>>)[1]?.excerpt, 'Parser fixed');
  assert.equal(messages.structuredContent?.truncated, false);
  const messageSearchSchema = (server as any)._registeredTools.search_thread_messages.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(messageSearchSchema.safeParse(messages.structuredContent).success, true);
  const page = await toolOf(server, 'get_thread_messages_page').handler({ threadId: 'thread-a', offset: 1, limit: 1 }, ctx);
  assert.equal(page.structuredContent?.totalMessages, 3);
  assert.equal(page.structuredContent?.hasMore, true);
  assert.equal(page.structuredContent?.nextOffset, 2);
  const pageSchema = (server as any)._registeredTools.get_thread_messages_page.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(pageSchema.safeParse(page.structuredContent).success, true);
  const lastPage = await toolOf(server, 'get_thread_messages_page').handler({ threadId: 'thread-a', offset: 2, limit: 1 }, ctx);
  assert.equal(lastPage.structuredContent?.hasMore, false);
  assert.equal(lastPage.structuredContent?.nextOffset, null);
  const threadPage = await toolOf(server, 'list_threads_page').handler({ limit: 1 }, ctx);
  assert.equal(threadPage.structuredContent?.totalThreads, 2);
  assert.equal(threadPage.structuredContent?.hasMore, true);
  const threadPageSchema = (server as any)._registeredTools.list_threads_page.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(threadPageSchema.safeParse(threadPage.structuredContent).success, true);
  const searchPage = await toolOf(server, 'search_threads_page').handler({ query: 'parser', limit: 1 }, ctx);
  assert.equal(searchPage.structuredContent?.totalMatches, 1);
  assert.equal(searchPage.structuredContent?.hasMore, false);
  const searchPageSchema = (server as any)._registeredTools.search_threads_page.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(searchPageSchema.safeParse(searchPage.structuredContent).success, true);
});

test('message search marks capped results as truncated and preserves total counts', async () => {
  const backend = {
    kind: 'desktop' as const,
    getMessages: async () => Array.from({ length: 25 }, (_, index) => ({ role: 'user', content: `match ${index}` })),
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const server = createV2ServerFromAdapter({ backend, sessions, turns: new TurnManager(sessions) });
  const response = await toolOf(server, 'search_thread_messages').handler({ threadId: 'thread-a', query: 'match', limit: 10 }, undefined);
  assert.equal((response.structuredContent?.matches as unknown[]).length, 10);
  assert.equal(response.structuredContent?.matchesInScannedMessages, 25);
  assert.equal(response.structuredContent?.truncated, true);
  const outputSchema = (server as any)._registeredTools.search_thread_messages.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(outputSchema.safeParse(response.structuredContent).success, true);
});

test('list_thread_attachments routes to the owner and reports unsupported capability', async () => {
  const desktopCalls: string[] = [];
  const desktop = { kind: 'desktop' as const, listAttachments: async (id: string) => { desktopCalls.push(`desktop:${id}`); return [{ name: 'image.png' }]; }, dispose: () => undefined };
  const cli = { kind: 'cli' as const, dispose: () => undefined };
  const backend = new CompositeBackend({ desktop, cli } as never);
  backend.useExisting('cli', 'conversation-1', '/tmp/project');
  const sessions = new SessionManager(backend);
  const server = createV2ServerFromAdapter({ backend, sessions, turns: new TurnManager(sessions) });
  const ctx = { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => undefined } };
  const response = await toolOf(server, 'list_thread_attachments').handler({ threadId: 'conversation-1' }, ctx);
  assert.equal(response.structuredContent?.ok, false);
  assert.equal(response.structuredContent?.code, 'FREEBUFF_BACKEND_UNAVAILABLE');
  assert.deepEqual(desktopCalls, [], 'a CLI conversation must never be read through Desktop');
});

test('write tools reject conflicting bridge and backend identities', async () => {
  const backend = {
    kind: 'desktop' as const,
    probe: async () => ({ backend: 'desktop' as const, connection: 'connected_writable' as const, authorization: 'write_authorized' as const, liveProgress: 'unavailable' as const, canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    createSession: async ({ cwd }: { cwd: string }) => ({ id: 'bridge-session', backend: 'desktop' as const, backendSessionId: 'thread-a', cwd }),
    sendMessage: async () => ({ state: 'completed' as const }),
    stop: async () => undefined,
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
  const sessions = new SessionManager(backend);
  const session = await sessions.createSession({ cwd: '/tmp/project' });
  const server = createV2ServerFromAdapter({ backend: backend as unknown as CompositeBackend, sessions, turns: new TurnManager(sessions) });
  const ctx = { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => undefined } };
  const send = await toolOf(server, 'send_message').handler({ sessionId: session.id, threadId: 'thread-b', text: 'do work' }, ctx);
  assert.equal(send.structuredContent?.ok, false);
  assert.equal(send.structuredContent?.code, 'FREEBUFF_INVALID_INPUT');
  const stop = await toolOf(server, 'stop_thread').handler({ sessionId: session.id, threadId: 'thread-a' }, ctx);
  assert.equal(stop.structuredContent?.ok, false);
  assert.equal(stop.structuredContent?.code, 'FREEBUFF_INVALID_INPUT');
  const resume = await toolOf(server, 'resume_thread').handler({ sessionId: session.id, threadId: 'thread-b' }, ctx);
  assert.equal(resume.structuredContent?.ok, false);
  assert.equal(resume.structuredContent?.code, 'FREEBUFF_INVALID_INPUT');
});

test('published input schemas reject conflicting or missing identities before handlers run', () => {
  const tools = (createV2ServerFromAdapter(makeAdapter()) as any)._registeredTools;
  assert.equal(tools.send_message.inputSchema.safeParse({ text: 'go', sessionId: 's1', threadId: 't1' }).success, false);
  assert.equal(tools.run_turn.inputSchema.safeParse({ text: 'go', sessionId: 's1', threadId: 't1' }).success, false);
  assert.equal(tools.send_message.inputSchema.safeParse({ text: 'new session' }).success, true);
  assert.equal(tools.stop_thread.inputSchema.safeParse({}).success, false);
  assert.equal(tools.stop_thread.inputSchema.safeParse({ sessionId: 's1', threadId: 't1' }).success, false);
});

test('declared output schemas accept structured failures as well as successful results', async () => {
  const backend = {
    kind: 'desktop' as const,
    probe: async () => { throw new Error('status probe failed'); },
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const server = createV2ServerFromAdapter({ backend, sessions, turns: new TurnManager(sessions) });
  const response = await toolOf(server, 'get_freebuff_status').handler({}, undefined);
  assert.equal(response.structuredContent?.ok, false);
  const outputSchema = (server as any)._registeredTools.get_freebuff_status.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(outputSchema.safeParse(response.structuredContent).success, true);
});

test('status reports attachment support from the selected backend instead of implying it', async () => {
  const backend = {
    kind: 'desktop' as const,
    probe: async () => ({ backend: 'cli' as const, connection: 'cli_ready' as const, authorization: 'write_authorized' as const, liveProgress: 'unavailable' as const, canCreateSession: true, canSendMessage: true, canStop: true, canResume: false, canSetModel: true, canSetReasoning: true, canListAttachments: false, notes: [] }),
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const server = createV2ServerFromAdapter({ backend, sessions, turns: new TurnManager(sessions) });
  const response = await toolOf(server, 'get_freebuff_status').handler({}, undefined);
  assert.equal((response.structuredContent?.capabilities as Record<string, unknown>).canListAttachments, false);
  const outputSchema = (server as any)._registeredTools.get_freebuff_status.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(outputSchema.safeParse(response.structuredContent).success, true);
});

test('MCP v2 tools publish complete behavioral hints and described input fields', () => {
  const server = createV2ServerFromAdapter(makeAdapter());
  const tools = (server as unknown as { _registeredTools: Record<string, { annotations?: Record<string, unknown>; inputSchema: { shape?: Record<string, { description?: string }>; options?: Array<{ shape: Record<string, { description?: string }> }> }; description?: string }> })._registeredTools;
  for (const [name, tool] of Object.entries(tools)) {
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations?.[hint], 'boolean', `${name} must declare ${hint}`);
    }
    assert.ok(tool.description && tool.description.length >= 30, `${name} needs an actionable description`);
    const variants = tool.inputSchema.options ?? [tool.inputSchema];
    for (const variant of variants) {
      for (const [field, schema] of Object.entries(variant.shape ?? {})) {
        assert.ok(schema.description && schema.description.length >= 10, `${name}.${field} needs a useful description`);
      }
    }
  }
  assert.equal(tools.run_turn!.annotations?.destructiveHint, true, 'turns may cause Freebuff to modify project files or run commands');
  assert.equal(tools.send_message!.annotations?.destructiveHint, true, 'messages may cause Freebuff to modify project files or run commands');
  assert.equal(tools.get_turn!.annotations?.openWorldHint, false, 'canonical turn state is served from the local bridge store');
  assert.equal(tools.get_freebuff_status!.annotations?.openWorldHint, true, 'status probes the external Freebuff installation');
});

test('canonical names keep aliases working and expose thread settings explicitly', async () => {
  let created = 0;
  const backend = {
    kind: 'desktop' as const,
    probe: async () => ({ backend: 'desktop' as const, connection: 'connected_writable' as const, authorization: 'write_authorized' as const, liveProgress: 'unavailable' as const, canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    createSession: async ({ cwd }: { cwd: string }) => { created += 1; return { id: `thread-${created}`, backend: 'desktop' as const, backendSessionId: `thread-${created}`, cwd }; },
    getThread: async () => ({ id: 'thread-settings', model: 'z-ai/glm-5.3-flash', harnessId: 'codebuff', reasoningEffort: null }),
    sendMessage: async () => ({ state: 'completed' as const }),
    dispose: () => undefined,
  } as unknown as FreebuffBackend;
  const sessions = new SessionManager(backend);
  const adapter = { backend: backend as unknown as CompositeBackend, sessions, turns: new TurnManager(sessions) };
  const server = createV2ServerFromAdapter(adapter);
  const ctx = { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => undefined } };

  const canonical = await toolOf(server, 'create_thread').handler({ cwd: '/tmp/project' }, ctx);
  const legacy = await toolOf(server, 'start_thread').handler({ cwd: '/tmp/project' }, ctx);
  assert.equal(created, 2, 'canonical and compatibility names create real backend sessions');
  assert.equal(canonical.structuredContent?.threadId, 'thread-1');
  assert.equal(legacy.structuredContent?.threadId, 'thread-2');
  const registered = (server as any)._registeredTools as Record<string, any>;
  assert.ok(registered.create_thread.outputSchema?.safeParse(canonical.structuredContent).success, 'create_thread output matches its declared schema');
  assert.ok(registered.start_thread.outputSchema?.safeParse(legacy.structuredContent).success, 'start_thread alias keeps the same output contract');

  const settings = await toolOf(server, 'get_thread_settings').handler({ threadId: 'thread-settings' }, ctx);
  assert.deepEqual(settings.structuredContent?.settings, { model: 'z-ai/glm-5.3-flash', harnessId: 'codebuff', reasoningEffort: null });
  assert.deepEqual(settings.structuredContent?.availableFields, ['model', 'harnessId', 'reasoningEffort']);
  const settingsOutput = registered.get_thread_settings!.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.ok(settingsOutput?.safeParse(settings.structuredContent).success, 'declared output schema matches returned settings');
});

test('get_thread_settings reports unavailable fields instead of guessing on a backend that omits them', async () => {
  const backend = {
    kind: 'desktop' as const,
    getThread: async () => ({ id: 'thread-without-settings', turnState: 'idle' }),
    listThreads: async () => [],
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const server = createV2ServerFromAdapter({ backend, sessions, turns: new TurnManager(sessions) });
  const result = await toolOf(server, 'get_thread_settings').handler({ threadId: 'thread-without-settings' }, undefined);
  assert.deepEqual(result.structuredContent?.settings, {});
  assert.deepEqual(result.structuredContent?.unavailableFields, ['model', 'harnessId', 'reasoningEffort']);
});

test('get_thread_settings fills omitted fields from the matching project thread record', async () => {
  const backend = {
    kind: 'desktop' as const,
    getThread: async () => ({ id: 'thread-settings', model: 'z-ai/glm-5.3-flash', harnessId: 'codebuff' }),
    listThreads: async () => [{ id: 'thread-settings', reasoningEffort: 'high' }, { id: 'other-thread', reasoningEffort: 'low' }],
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const server = createV2ServerFromAdapter({ backend, sessions, turns: new TurnManager(sessions) });
  const result = await toolOf(server, 'get_thread_settings').handler({ threadId: 'thread-settings' }, undefined);
  assert.deepEqual(result.structuredContent?.settings, { model: 'z-ai/glm-5.3-flash', harnessId: 'codebuff', reasoningEffort: 'high' });
  assert.deepEqual(result.structuredContent?.unavailableFields, []);
  const outputSchema = (server as any)._registeredTools.get_thread_settings.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.ok(outputSchema?.safeParse(result.structuredContent).success);
});

test('MCP v2 project file tools are restricted to roots returned by list_projects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-approved-project-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-unlisted-project-'));
  const desktop = new DesktopBackend();
  const backend = {
    kind: 'desktop' as const,
    desktop,
    probe: async () => ({ backend: 'desktop' as const, connection: 'connected_read_only' as const, authorization: 'none' as const, liveProgress: 'unavailable' as const, canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: [] }),
    listProjects: async () => [{ id: root, path: root, name: path.basename(root) }],
    dispose: () => desktop.dispose(),
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const adapter: V2Adapter = { backend, sessions, turns: new TurnManager(sessions) };
  const server = createV2ServerFromAdapter(adapter);
  const ctx = { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => undefined } };
  try {
    await fs.writeFile(path.join(root, 'README.md'), 'inside the selected project');
    await fs.writeFile(path.join(outside, 'private.txt'), 'outside the selected project');
    const allowed = await toolOf(server, 'read_project_file').handler({ projectId: root, path: 'README.md' }, ctx);
    assert.equal(allowed.structuredContent?.content, 'inside the selected project');
    const canonical = await toolOf(server, 'get_project_file').handler({ projectId: root, path: 'README.md' }, ctx);
    assert.equal(canonical.structuredContent?.content, 'inside the selected project');

    const denied = await toolOf(server, 'read_project_file').handler({ projectId: outside, path: 'private.txt' }, ctx);
    assert.equal(denied.structuredContent?.ok, false);
    assert.match(String(denied.structuredContent?.message), /project/i);

    const listed = await toolOf(server, 'list_project_files').handler({ projectId: outside }, ctx);
    assert.equal(listed.structuredContent?.ok, false);
  } finally {
    desktop.dispose();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('MCP v2: resume_thread uses the Desktop resume route instead of submitting /resume as a prompt', async () => {
  const calls: string[] = [];
  const backend = {
    kind: 'desktop' as const,
    resume: async (session: { backendSessionId?: string }) => { calls.push(`resume:${session.backendSessionId}`); return { state: 'waiting_for_user' as const }; },
    probe: async () => ({ backend: 'desktop' as const, connection: 'connected_writable' as const, authorization: 'write_authorized' as const, liveProgress: 'connected' as const, canCreateSession: true, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }),
    sendMessage: async () => { calls.push('sendMessage'); return { state: 'completed' as const }; },
    dispose: () => undefined,
  } as unknown as CompositeBackend;
  const sessions = new SessionManager(backend as unknown as FreebuffBackend);
  const adapter: V2Adapter = { backend, sessions, turns: new TurnManager(sessions) };
  const server = createV2ServerFromAdapter(adapter);
  const session = await sessions.registerExisting({ backendSessionId: 'thread-abc', cwd: '/tmp/project' });

  const ctx = { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => undefined } };
  const result = await toolOf(server, 'resume_thread').handler({ sessionId: session.id, threadId: 'thread-abc' }, ctx);
  assert.equal(result.structuredContent?.ok, true);
  assert.deepEqual(calls, ['resume:thread-abc'], 'the backend resume operation is used and no prompt is submitted');

  // threadId is the required argument, so it must work on its own.
  const byThreadOnly = await toolOf(server, 'resume_thread').handler({ threadId: 'thread-xyz' }, ctx);
  assert.equal(byThreadOnly.structuredContent?.ok, true);
  assert.deepEqual(calls, ['resume:thread-abc', 'resume:thread-xyz'], 'a bare threadId still resumes through the backend');
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
  const legacy = await toolOf(server, 'freebuff_status').handler({}, undefined);
  const canonical = await toolOf(server, 'get_freebuff_status').handler({}, undefined);
  assert.deepEqual(canonical.structuredContent, legacy.structuredContent);
});

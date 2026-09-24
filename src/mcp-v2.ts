import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { CompositeBackend } from './backends/backend.js';
import { MAX_DIFF_FILES } from './backends/desktop-backend.js';
import { SessionManager } from './bridge/session-manager.js';
import { TurnManager } from './bridge/turn-manager.js';
import { BackendTurnResult, BridgeError, ErrorCodes, toErrorShape, BackendSession } from './bridge/types.js';
import { Json } from './types.js';
import { assertSafeId, redact } from './security.js';
import { VERSION } from './version.js';

const json = (value: unknown): Json => value as Json;

/**
 * Helper: structured tool result. Model-visible failures (`{ ok: false }`)
 * are marked `isError: true` so MCP clients surface them as errors instead of
 * silently treating a failure payload as a successful answer.
 */
const result = (value: unknown) => {
  const failed = !!value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).ok === false;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: json(value),
    ...(failed ? { isError: true as const } : {}),
  };
};
const id = z.string().min(1).max(200);

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

interface DesktopChangesApi {
  getChanges(threadId: string, scope?: 'all' | 'uncommitted'): Promise<unknown>;
  getDiff(threadId: string, file: string, scope?: 'all' | 'uncommitted'): Promise<unknown>;
}

/** The Desktop change/diff routes are optional: say so clearly, never invent data. */
function desktopChanges(adapter: V2Adapter): DesktopChangesApi {
  const desktop = adapter.backend.desktop as unknown as Partial<DesktopChangesApi> | undefined;
  const missing = (what: string): BridgeError => new BridgeError(
    ErrorCodes.DESKTOP_API_INCOMPATIBLE,
    `The Desktop ${what} is unavailable.`,
    'This requires an authorized Freebuff Desktop; CLI-mode sessions expose no change summary. Use get_changed_files for event-derived paths.',
  );
  return {
    getChanges: (threadId, scope = 'all') => {
      if (!desktop || typeof desktop.getChanges !== 'function') throw missing('change-summary route');
      return desktop.getChanges(threadId, scope);
    },
    getDiff: (threadId, file, scope = 'all') => {
      if (!desktop || typeof desktop.getDiff !== 'function') throw missing('diff route');
      return desktop.getDiff(threadId, file, scope);
    },
  };
}

export interface V2Adapter {
  backend: CompositeBackend;
  sessions: SessionManager;
  turns: TurnManager;
}

export function createV2ServerFromAdapter(adapter: V2Adapter): McpServer {
  const server = new McpServer({ name: 'freebuff-mcp', version: VERSION, description: 'Freebuff MCP v2 interoperability surface' });
  const read = (name: string, description: string, inputSchema: z.ZodRawShape, fn: (args: any) => Promise<unknown>) => server.registerTool(name, { description, inputSchema: z.object(inputSchema), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (args) => result(await fn(args ?? {})));
  const write = (name: string, description: string, inputSchema: z.ZodRawShape, fn: (args: any, ctx: { signal: AbortSignal; progressToken: unknown; progress: (message: string) => Promise<void>; notifyProgress: (params: { progressToken: unknown; progress: number; message: string }) => Promise<void> }) => Promise<unknown>) => server.registerTool(name, { description, inputSchema: z.object(inputSchema), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async (args, ctx) => {
    const progressToken = (ctx.mcpReq._meta as { progressToken?: unknown } | undefined)?.progressToken;
    return result(await fn(args ?? {}, {
      signal: ctx.mcpReq.signal,
      progressToken,
      notifyProgress: async (params: { progressToken: unknown; progress: number; message: string }) => {
        try { await ctx.mcpReq.notify({ method: 'notifications/progress', params: { ...params } }); } catch { /* client may be gone */ }
      },
      progress: async (message: string) => {
        if (progressToken === undefined) return;
        try { await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: 0, message } }); } catch { /* client may be gone */ }
      },
    }));
  });

  const shapeError = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try { return await fn(); } catch (error) { return toErrorShape(error); }
  };

  // --- Status & discovery (always registered; availability is data, not absence) ---
  read('freebuff_status', 'Detect Freebuff and bridge capabilities.', {}, (args) => shapeError(async () => {
    void args;
    const caps = await adapter.backend.probe();
    return { ok: true, backend: caps.backend, connection: caps.connection, authorization: caps.authorization, liveProgress: caps.liveProgress, capabilities: { canCreateSession: caps.canCreateSession, canSendMessage: caps.canSendMessage, canStop: caps.canStop, canResume: caps.canResume, canSetModel: caps.canSetModel, canSetReasoning: caps.canSetReasoning }, notes: caps.notes };
  }));

  const requireSessions = async () => { const caps = await adapter.backend.probe(); if (caps.connection === 'unavailable' || caps.connection === 'not_running' || caps.connection === 'not_installed') throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'Freebuff is not available.', JSON.stringify(toErrorShape(new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'Freebuff is not available.')).recovery)); return caps; };

  read('list_projects', 'List discovered Freebuff projects.', {}, () => shapeError(async () => { await requireSessions(); return adapter.backend.listProjects(); }));
  read('list_threads', 'List Freebuff threads.', { projectId: id.optional() }, (args) => shapeError(async () => { await requireSessions(); const threads = await adapter.backend.listThreads(); return args.projectId ? (Array.isArray(threads) ? threads : []).filter((t) => (t as Record<string, unknown>).projectId === args.projectId || (t as Record<string, unknown>).projectPath === args.projectId) : threads; }));
  read('get_thread', 'Read thread metadata.', { threadId: id }, (args) => shapeError(() => adapter.backend.getThread(assertSafeId(args.threadId))));
  read('get_thread_messages', 'Read visible thread messages.', { threadId: id }, (args) => shapeError(() => adapter.backend.getMessages(assertSafeId(args.threadId))));
  read('get_active_work', 'Read visible active work.', {}, () => shapeError(async () => {
    await requireSessions();
    const threads = await adapter.backend.listThreads();
    return (Array.isArray(threads) ? threads : []).filter((t) => { const state = (t as Record<string, unknown>).turnState; return typeof state === 'string' && !['idle', 'completed', 'failed', 'cancelled'].includes(state); });
  }));
  read('get_turn', 'Read canonical turn state and recent events.', { turnId: id, afterSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }, (args) => shapeError(async () => {
    const snapshot = adapter.turns.progressForTurn(assertSafeId(args.turnId), args.afterSequence ?? 0, args.limit ?? 50);
    const turn = adapter.turns.getTurn(assertSafeId(args.turnId));
    return { ok: true, turnId: turn.id, sessionId: turn.sessionId, state: turn.state, backendTurnId: turn.backendTurnId, error: turn.error, snapshot };
  }));
  read('get_thread_progress', 'Read bounded live thread progress.', { threadId: id, afterSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }, (args) => shapeError(async () => adapter.sessions.events.progress(assertSafeId(args.threadId), args.afterSequence ?? 0, args.limit ?? 50)));
  read('watch_thread', 'Wait up to 30 seconds for live thread progress.', { threadId: id, afterSequence: z.number().int().nonnegative().optional(), timeoutMs: z.number().int().min(0).max(30000).optional(), limit: z.number().int().min(1).max(100).optional() }, (args) => shapeError(() => adapter.sessions.events.wait(assertSafeId(args.threadId), args.afterSequence ?? 0, args.timeoutMs ?? 30_000, args.limit ?? 50)));
  read('get_thread_progress_summary', 'Return a compact user-facing live progress summary without raw event detail.', { threadId: id }, (args) => shapeError(async () => {
    const snapshot = adapter.sessions.events.progress(assertSafeId(args.threadId), 0, 1);
    return {
      ok: true,
      threadId: snapshot.threadId,
      state: snapshot.currentState,
      turnState: snapshot.turnState,
      phase: snapshot.phase,
      connected: snapshot.connected,
      stale: snapshot.stale,
      latestEventAt: snapshot.latestEventAt,
      activeTool: snapshot.activeTool,
      filesChanged: snapshot.filesChanged,
      secondsSinceLastEvent: snapshot.secondsSinceLastEvent,
      lastError: snapshot.lastError,
    };
  }));
  read('watch_turn', 'Wait up to 30 seconds for canonical turn progress.', { turnId: id, timeoutMs: z.number().int().min(0).max(30000).optional(), afterSequence: z.number().int().nonnegative().optional() }, (args) => shapeError(() => adapter.turns.waitForTurn(assertSafeId(args.turnId), args.timeoutMs ?? 30_000, args.afterSequence ?? 0)));
  read('watch_active_threads', 'Read compact progress summaries for active threads.', {}, () => shapeError(async () => adapter.sessions.events.activeThreads().map((threadId) => adapter.sessions.events.progress(threadId, 0, 1))));
  read('list_project_files', 'List safe files in a project.', { projectId: id, relative: z.string().optional() }, (args) => shapeError(async () => { const caps = await adapter.backend.probe(); return caps.backend === 'cli' ? [] : (adapter.backend.desktop as unknown as { listFiles(root: string, relative?: string): Promise<string[]> }).listFiles(args.projectId, args.relative); }));
  read('read_project_file', 'Read one safe project file.', { projectId: id, path: z.string() }, (args) => shapeError(async () => (adapter.backend.desktop as unknown as { readFile(root: string, relative: string): Promise<{ path: string; content: string }> }).readFile(args.projectId, args.path)));
  read('list_thread_attachments', 'List safe attachment metadata for a thread.', { threadId: id }, (args) => shapeError(() => adapter.backend.desktop.listAttachments(assertSafeId(args.threadId))));
  read('list_models', 'List available model information.', {}, () => shapeError(async () => {
    // The Desktop exposes no model-catalog route, and getThread('') is an
    // invalid id that must never be called. Report honestly what is known.
    const caps = await requireSessions();
    return {
      ok: true,
      catalogAvailable: false,
      backend: caps.backend,
      connection: caps.connection,
      note: 'The installed Freebuff Desktop exposes no standalone model-catalog route. Use get_thread to read the current thread model and set_model to change it.',
    };
  }));
  read('search_history', 'Search visible Freebuff history.', { query: z.string().min(1).max(200) }, (args) => shapeError(async () => {
    await requireSessions();
    const threads = await adapter.backend.listThreads();
    const q = args.query.toLowerCase();
    return (Array.isArray(threads) ? threads : []).filter((t) => JSON.stringify(t).toLowerCase().includes(q)).slice(0, 100);
  }));

  // --- Session/turn lifecycle ---
  write('start_thread', 'Create a bridge session backed by a real Freebuff identity.', { cwd: z.string().optional(), continueConversationId: id.optional() }, async (args) => shapeError(async () => {
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : (process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd());
    const session = await adapter.sessions.createSession({ cwd, ...(args.continueConversationId ? { continueBackendId: assertSafeId(args.continueConversationId) } : {}) });
    return { ok: true, sessionId: session.id, backend: session.backend, backendSessionId: session.backendSessionId, backendHandleId: session.backendHandleId, state: session.state };
  }));

  write('send_message', 'Submit text to a bridge session without waiting for completion (async).', { sessionId: id.optional(), threadId: id.optional(), text: z.string().min(1).max(100000) }, async (args) => shapeError(async () => {
    const sessionId = await resolveSessionId(adapter, args);
    const { turnId, done } = adapter.turns.startTurnDetached(sessionId, { text: args.text });
    void done.catch(() => undefined);
    const turn = adapter.turns.getTurn(turnId);
    return { ok: true, turnId, sessionId, state: turn.state, note: 'Poll get_turn or watch_turn with this turnId for progress and the final result.' };
  }));

  write('run_turn', 'Run a full Freebuff turn and wait for completion. Emits request-scoped progress and honors MCP cancellation.', { sessionId: id.optional(), threadId: id.optional(), text: z.string().min(1).max(100000) }, async (args, ctx) => shapeError(async () => {
    const sessionId = await resolveSessionId(adapter, args);
    const controller = new AbortController();
    const onClientAbort = () => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener('abort', onClientAbort, { once: true });
    try {
      const handle = adapter.sessions.startTurn(sessionId, { text: args.text, signal: controller.signal });
      adapter.sessions.registerController(handle.turn.id, controller);
      // Request-scoped progress: coalesced, meaningful, never token-level.
      let lastSeq = 0;
      const progressToken = ctx.progressToken;
      const unsubscribe = adapter.sessions.events.subscribe(() => {
        void (async () => {
          const turn = adapter.sessions.getTurn(handle.turn.id);
          if (!turn || turn.lastSequence <= lastSeq || progressToken === undefined) return;
          lastSeq = turn.lastSequence;
          const page = adapter.sessions.events.read({ turnId: handle.turn.id, afterSequence: lastSeq ? lastSeq - 1 : 0, limit: 1 });
          const latest = page.events.at(-1);
          const message = latest ? describeEvent(latest.type, latest.message, latest.tool, latest.phase) : undefined;
          if (!message) return;
          try { await ctx.notifyProgress({ progressToken, progress: turn.lastSequence, message }); } catch { /* client may be gone */ }
        })();
      });
      try {
        const turn = await handle.done;
        return { ok: turn.state !== 'failed', turnId: turn.id, sessionId, state: turn.state, backendTurnId: turn.backendTurnId, result: turn.result, ...(turn.error ? { error: turn.error } : {}) };
      } finally {
        unsubscribe();
        adapter.sessions.unregisterController(handle.turn.id);
      }
    } finally {
      ctx.signal.removeEventListener('abort', onClientAbort);
    }
  }));

  write('stop_turn', 'Cancel a running canonical turn and stop it on the owning backend.', { sessionId: id, turnId: id.optional() }, async (args) => shapeError(async () => {
    const result = await adapter.turns.cancelTurn(assertSafeId(args.sessionId), args.turnId ? assertSafeId(args.turnId) : undefined);
    return {
      ok: true,
      cancelled: result.aborted,
      stopped: result.stopped,
      ...(result.stopError ? { stopError: result.stopError } : {}),
      note: !result.aborted
        ? 'No active turn matched; the turn may have already finished.'
        : result.stopped
          ? 'The active turn was aborted and the owning backend confirmed the stop.'
          : result.stopError
            ? `The active turn was aborted locally, but the backend stop failed (${result.stopError}) — the underlying work may still be running.`
            : 'The active turn was aborted locally; the backend exposes no stop operation to confirm.',
    };
  }));

  write('stop_thread', 'Stop a running Freebuff turn.', { threadId: id, sessionId: id.optional() }, async (args) => shapeError(async () => {
    // Resolve ownership exactly like set_model does: a bare thread id is
    // wrapped through registerExisting/resolveExisting so CLI conversations
    // stop on the CLI instead of being forced onto the Desktop.
    const session = args.sessionId
      ? adapter.sessions.getSession(assertSafeId(args.sessionId))
      : await findSessionByBackendId(adapter, assertSafeId(args.threadId));
    if (session) { await adapter.backend.stop(adapter.sessions.toBackendSession(session)); return { ok: true }; }
    throw new BridgeError(ErrorCodes.SESSION_NOT_FOUND, 'Stopping requires a bridge session created through start_thread.', 'Call start_thread with the conversation id, then stop_turn.');
  }));

  write('resume_thread', 'Resume a paused Freebuff thread.', { threadId: id, sessionId: id.optional() }, async (args) => shapeError(async () => {
    const threadId = assertSafeId(args.threadId);
    // `threadId` is the required argument: resolve ownership through the same
    // registerExisting/resolveExisting path as set_model, so a CLI
    // conversation id resumes on the CLI instead of defaulting to Desktop.
    const session = args.sessionId
      ? adapter.sessions.getSession(assertSafeId(args.sessionId))
      : await findSessionByBackendId(adapter, threadId);
    const backendSession: BackendSession = session ? adapter.sessions.toBackendSession(session) : { id: threadId, backend: 'desktop' as const, backendSessionId: threadId, cwd: process.cwd() };
    // Resuming is backend-specific. The Desktop unpauses the thread's queue
    // through its own route (`POST /api/thread/:id/resume`), which needs only
    // the thread id; only the CLI harness takes `/resume` as a command.
    // Submitting `/resume` as Desktop prompt text would start a turn with that
    // literal text instead.
    const result = backendSession.backend === 'cli'
      ? await adapter.backend.sendMessage({ session: backendSession, text: '/resume' })
      : await (adapter.backend as unknown as { resume(session: BackendSession): Promise<BackendTurnResult> }).resume(backendSession);
    if (session) adapter.sessions.reconcileResume(session.id, result);
    return { ok: true, ...result } as Json;
  }));

  write('set_model', 'Set the model for an existing thread.', { threadId: id, model: z.string().min(1).max(200), harnessId: z.string().optional() }, async (args) => shapeError(async () => {
    const session = await findSessionByBackendId(adapter, assertSafeId(args.threadId));
    if (!session) throw new BridgeError(ErrorCodes.SESSION_NOT_FOUND, 'set_model requires a bridge session for this thread.', 'Call start_thread first.');
    const backendSession = adapter.sessions.toBackendSession(session);
    // Capability checks route through the SESSION OWNER, not the global
    // facade: a read-only Desktop plus a writable CLI session must still allow
    // model changes on the CLI-owned thread. The owner's own method returns
    // the real error when it genuinely cannot comply.
    if (session.backend !== 'cli') {
      const caps = await adapter.backend.probe();
      if (!caps.canSetModel) throw new BridgeError(ErrorCodes.DESKTOP_AUTH_REQUIRED, 'Model changes require write authorization.');
    }
    if (typeof adapter.backend.setModel !== 'function') throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, `The ${session.backend} backend cannot change models.`);
    await adapter.backend.setModel(backendSession, args.model, args.harnessId);
    return { ok: true };
  }));

  write('set_reasoning', 'Set reasoning effort for an existing thread.', { threadId: id, effort: z.string().nullable() }, async (args) => shapeError(async () => {
    const session = await findSessionByBackendId(adapter, assertSafeId(args.threadId));
    if (!session) throw new BridgeError(ErrorCodes.SESSION_NOT_FOUND, 'set_reasoning requires a bridge session for this thread.', 'Call start_thread first.');
    const backendSession = adapter.sessions.toBackendSession(session);
    if (session.backend !== 'cli') {
      const caps = await adapter.backend.probe();
      if (!caps.canSetReasoning) throw new BridgeError(ErrorCodes.DESKTOP_AUTH_REQUIRED, 'Reasoning changes require write authorization.');
    }
    if (typeof adapter.backend.setReasoning !== 'function') throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, `The ${session.backend} backend cannot change reasoning effort.`);
    await adapter.backend.setReasoning(backendSession, args.effort);
    return { ok: true };
  }));

  read('get_changed_files', 'List files changed during the most recent events for a thread.', { threadId: id }, (args) => shapeError(async () => {
    const snapshot = adapter.sessions.events.progress(assertSafeId(args.threadId), 0, 100);
    return { ok: true, threadId: args.threadId, files: snapshot.filesChanged ?? [] };
  }));
  read('get_changes', 'Read the Desktop change summary (files, adds, dels) for a thread.', { threadId: id, scope: z.enum(['all', 'uncommitted']).optional() }, (args) => shapeError(async () => {
    const changes = await desktopChanges(adapter).getChanges(assertSafeId(args.threadId), args.scope ?? 'all');
    return { ok: true, ...(asObject(changes) ?? { changes }) };
  }));

  read('get_diff', 'Read real per-file diffs for a thread from the Desktop, falling back to the changed files observed in live events.', { threadId: id, file: z.string().optional(), scope: z.enum(['all', 'uncommitted']).optional() }, (args) => shapeError(async () => {
    const threadId = assertSafeId(args.threadId);
    const scope = args.scope ?? 'all';
    const desktop = desktopChanges(adapter);
    const eventFiles = adapter.sessions.events.progress(threadId, 0, 100).filesChanged ?? [];

    let changes: Record<string, unknown> | undefined;
    try { changes = asObject(await desktop.getChanges(threadId, scope)); } catch { changes = undefined; }

    const changed = Array.isArray(changes?.files)
      ? (changes!.files as unknown[]).flatMap((entry) => { const record = asObject(entry); const path = typeof record?.path === 'string' ? record.path : undefined; return path ? [{ path, adds: typeof record?.adds === 'number' ? record.adds : undefined, dels: typeof record?.dels === 'number' ? record.dels : undefined }] : []; })
      : eventFiles.map((path) => ({ path, adds: undefined as number | undefined, dels: undefined as number | undefined }));

    const requested = typeof args.file === 'string' && args.file ? args.file : undefined;
    const targets = (requested ? changed.filter((f) => f.path === requested) : changed).slice(0, MAX_DIFF_FILES);

    const files: Array<Record<string, unknown>> = [];
    let unavailable = 0;
    for (const target of targets) {
      const entry: Record<string, unknown> = { path: target.path };
      if (target.adds !== undefined) entry.adds = target.adds;
      if (target.dels !== undefined) entry.dels = target.dels;
      try {
        // Real Desktop contract: `{ patch }` on success, or `{ error }`,
        // `{ tooLarge }`, `{ binary }` — never a fabricated diff.
        const result = asObject(await desktop.getDiff(threadId, target.path, scope));
        const text = typeof result?.patch === 'string' ? result.patch : typeof result?.diff === 'string' ? result.diff : undefined;
        if (text !== undefined) entry.diff = String(redact(text)).slice(0, 100_000);
        else if (result?.binary === true) entry.binary = true;
        else if (result?.tooLarge === true) entry.tooLarge = true;
        else if (typeof result?.error === 'string') entry.error = String(redact(result.error));
        else unavailable += 1;
      } catch (error) { entry.error = String(redact(error instanceof Error ? error.message : 'diff unavailable')); unavailable += 1; }
      files.push(entry);
    }

    return {
      ok: true,
      threadId,
      scope,
      ...(typeof changes?.branch === 'string' || changes?.branch === null ? { branch: changes?.branch } : {}),
      ...(asObject(changes?.totals) ? { totals: changes!.totals } : {}),
      files,
      ...(requested ? { requestedFile: requested } : {}),
      ...(changed.length > targets.length ? { truncated: true, changedFileCount: changed.length } : {}),
      diffAvailable: files.some((f) => typeof f.diff === 'string'),
      ...(unavailable ? { note: `${unavailable} file diff(s) could not be read from the Desktop; no diff text is ever invented.` } : {}),
    };
  }));

  // --- Resources (supplementary; throttled updates) ---
  server.registerResource('projects', 'freebuff://projects', { title: 'Freebuff projects', description: 'Current project snapshots', mimeType: 'application/json' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await shapeError(() => adapter.backend.listProjects())) }] }));
  server.registerResource('project-threads', new ResourceTemplate('freebuff://project/{projectId}/threads', { list: undefined }), { title: 'Project threads', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await shapeError(() => adapter.backend.listThreads())) }] }));
  server.registerResource('thread', new ResourceTemplate('freebuff://thread/{threadId}', { list: undefined }), { title: 'Freebuff thread', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await shapeError(() => adapter.backend.getThread(String(variables.threadId)))) }] }));
  server.registerResource('thread-messages', new ResourceTemplate('freebuff://thread/{threadId}/messages', { list: undefined }), { title: 'Thread messages', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await shapeError(() => adapter.backend.getMessages(String(variables.threadId)))) }] }));
  server.registerResource('thread-progress', new ResourceTemplate('freebuff://thread/{threadId}/progress', { list: undefined }), { title: 'Thread progress', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await shapeError(async () => adapter.sessions.events.progress(String(variables.threadId), 0, 1))) }] }));

  // Throttled resource updates: coalesce per thread, at most one update per
  // 2 seconds per thread, never per token.
  const pendingUpdates = new Map<string, NodeJS.Timeout>();
  const unsubscribeUpdates = adapter.sessions.events.subscribe((threadId) => {
    if (pendingUpdates.has(threadId)) return;
    const timer = setTimeout(() => { pendingUpdates.delete(threadId); void server.server.sendResourceUpdated({ uri: `freebuff://thread/${encodeURIComponent(threadId)}/progress` }).catch(() => undefined); }, 2_000);
    timer.unref?.();
    pendingUpdates.set(threadId, timer);
  });

  // Explicit disposal: when the server closes, drop the subscription and all
  // pending update timers instead of leaking them for the process lifetime.
  // Both paths are covered: the transport-driven onclose AND an explicit
  // close() call (either one may fire without the other).
  const disposeUpdates = (): void => {
    unsubscribeUpdates();
    for (const timer of pendingUpdates.values()) clearTimeout(timer);
    pendingUpdates.clear();
  };
  const inner = server.server as unknown as { onclose?: () => void };
  const previousOnClose = inner.onclose;
  inner.onclose = () => {
    try { previousOnClose?.(); } finally { disposeUpdates(); }
  };
  const typed = server as unknown as { close: () => Promise<void> };
  const originalClose = typed.close.bind(server);
  typed.close = async (): Promise<void> => {
    try { await originalClose(); } finally { disposeUpdates(); }
  };

  return server;
}

function describeEvent(type: string, message?: string, tool?: string, phase?: string): string {
  const phaseLabel = phase ? phase.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : undefined;
  if (message) return message.slice(0, 120);
  if (tool) return `${phaseLabel ?? type}: ${tool}`;
  return phaseLabel ?? type;
}

async function resolveSessionId(adapter: V2Adapter, args: { sessionId?: unknown; threadId?: unknown }): Promise<string> {
  if (typeof args.sessionId === 'string' && args.sessionId) {
    const session = adapter.sessions.getSession(args.sessionId);
    if (session) return session.id;
    throw new BridgeError(ErrorCodes.SESSION_NOT_FOUND, `Unknown bridge session ${args.sessionId}.`, 'Call start_thread first.');
  }
  if (typeof args.threadId === 'string' && args.threadId) {
    // threadId may be a real backend identity — wrap it (never guess identity,
    // and never assign a session to a backend that does not own the id).
    const existing = adapter.sessions.listSessions().find((s) => s.backendSessionId === args.threadId);
    if (existing) return existing.id;
    const session = await adapter.sessions.registerExisting({ backendSessionId: assertSafeId(args.threadId), cwd: process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd() });
    return session.id;
  }
  // Auto-create a session against the primary backend.
  const created = await adapter.sessions.createSession({ cwd: process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd() });
  return created.id;
}

async function findSessionByBackendId(adapter: V2Adapter, backendId: string) {
  return adapter.sessions.listSessions().find((s) => s.backendSessionId === backendId) ?? (await adapter.sessions.registerExisting({ backendSessionId: backendId, cwd: process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd() }));
}

export function createDefaultAdapter(): V2Adapter & { dispose(): void } {
  const backend = new CompositeBackend();
  const sessions = new SessionManager(backend);
  const turns = new TurnManager(sessions);
  return { backend, sessions, turns, dispose: () => { sessions.dispose(); backend.dispose(); } };
}

export async function runStdioV2(): Promise<void> {
  const adapter = createDefaultAdapter();
  const server = createV2ServerFromAdapter(adapter);
  const handle = serveStdio(() => server, { legacy: 'serve', maxSubscriptions: 64, onerror: (error) => console.error(error.message) });
  const cleanup = () => { adapter.dispose(); void handle.close(); };
  process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup); process.once('exit', cleanup);
}

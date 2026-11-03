import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { CompositeBackend } from './backends/backend.js';
import { MAX_DIFF_FILES } from './backends/desktop-backend.js';
import { SessionManager } from './bridge/session-manager.js';
import { TurnManager } from './bridge/turn-manager.js';
import { BackendTurnResult, BridgeError, ErrorCodes, toErrorShape, BackendSession, FreebuffBackend } from './bridge/types.js';
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
const toolErrorOutput = z.object({ ok: z.literal(false), code: z.string(), message: z.string(), recovery: z.string().optional() });
const withToolErrorOutput = (schema: z.ZodType): z.ZodType => z.union([schema, toolErrorOutput]);

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Extract user-visible message text without searching ids or transport metadata. */
function messageText(value: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((part) => messageText(part, depth + 1)).filter(Boolean).join('\n');
  const record = asObject(value);
  if (!record) return '';
  return ['content', 'text', 'message', 'value', 'parts', 'segments']
    .map((key) => messageText(record[key], depth + 1))
    .filter(Boolean)
    .join('\n');
}

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
  const inputDescriptions: Record<string, string> = {
    projectId: 'Project id or exact project path returned by list_projects.',
    threadId: 'Freebuff thread id returned by list_threads or create_thread.',
    sessionId: 'Bridge session id returned by create_thread.',
    turnId: 'Turn id returned by send_message or run_turn.',
    cwd: 'Absolute project directory to use as the session working directory.',
    continueConversationId: 'Existing Freebuff conversation id to attach this bridge session to.',
    text: 'Request text to send to Freebuff. The agent may edit project files or run commands.',
    model: 'Exact model id accepted by the selected Freebuff thread.',
    harnessId: 'Freebuff harness id to pair with the selected model, when needed.',
    effort: 'Reasoning effort accepted by the selected Freebuff thread; null clears the override.',
    path: 'Path relative to the selected project root. Absolute paths and escapes are rejected.',
    relative: 'Optional directory path relative to the selected project root.',
    offset: 'Zero-based result offset for paging through the current visible result set.',
    scope: 'Change range to inspect. all includes the full thread history; uncommitted limits results to current uncommitted work.',
    file: 'Optional exact changed-file path to limit diff output.',
    query: 'Case-insensitive text to find in visible thread metadata, limited to 200 characters.',
    afterSequence: 'Return events after this sequence number; use the last received sequence to continue paging.',
    limit: 'Maximum number of events to return, from 1 to 100.',
    timeoutMs: 'Maximum time to wait in milliseconds, from 0 to 30000.',
  };
  const describeInputs = (shape: z.ZodRawShape): z.ZodObject<z.ZodRawShape> => z.object(Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => {
      const typed = schema as z.ZodType;
      return [key, typed.description ? schema : typed.describe(inputDescriptions[key] ?? `Value for ${key}.`) as unknown as typeof schema];
    }),
  ) as z.ZodRawShape);
  const inputSchemaFor = (schema: z.ZodRawShape | z.ZodType): z.ZodType => schema instanceof z.ZodType ? schema : describeInputs(schema);
  const titleFor = (name: string) => name.split('_').map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ');
  const read = (name: string, description: string, inputSchema: z.ZodRawShape | z.ZodType, fn: (args: any) => Promise<unknown>, openWorldHint = true, outputSchema?: z.ZodType) => server.registerTool(name, { title: titleFor(name), description, inputSchema: inputSchemaFor(inputSchema), ...(outputSchema ? { outputSchema: withToolErrorOutput(outputSchema) } : {}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint } }, async (args) => result(await fn(args ?? {})));
  const write = (name: string, description: string, inputSchema: z.ZodRawShape | z.ZodType, fn: (args: any, ctx: { signal: AbortSignal; progressToken: unknown; progress: (message: string) => Promise<void>; notifyProgress: (params: { progressToken: unknown; progress: number; message: string }) => Promise<void> }) => Promise<unknown>, hints: { destructiveHint?: boolean; idempotentHint?: boolean; outputSchema?: z.ZodType } = {}) => server.registerTool(name, { title: titleFor(name), description, inputSchema: inputSchemaFor(inputSchema), ...(hints.outputSchema ? { outputSchema: withToolErrorOutput(hints.outputSchema) } : {}), annotations: { readOnlyHint: false, destructiveHint: hints.destructiveHint ?? false, idempotentHint: hints.idempotentHint ?? false, openWorldHint: true } }, async (args, ctx) => {
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
  const readFreebuffStatus = async () => shapeError(async () => {
    const caps = await adapter.backend.probe();
    return { ok: true, backend: caps.backend, connection: caps.connection, authorization: caps.authorization, liveProgress: caps.liveProgress, capabilities: { canCreateSession: caps.canCreateSession, canSendMessage: caps.canSendMessage, canStop: caps.canStop, canResume: caps.canResume, canSetModel: caps.canSetModel, canSetReasoning: caps.canSetReasoning, canListAttachments: caps.canListAttachments === true, canListModels: false }, notes: caps.notes };
  });
  const statusOutput = z.object({
    ok: z.boolean(), backend: z.string(), connection: z.string(), authorization: z.string(), liveProgress: z.string(),
    capabilities: z.object({ canCreateSession: z.boolean(), canSendMessage: z.boolean(), canStop: z.boolean(), canResume: z.boolean(), canSetModel: z.boolean(), canSetReasoning: z.boolean(), canListAttachments: z.boolean(), canListModels: z.boolean() }),
    notes: z.array(z.string()),
  });
  read('get_freebuff_status', 'Check whether Freebuff is installed, connected, authorized, and which actions this bridge can perform. A detected app may still be signed out or read-only.', {}, readFreebuffStatus, true, statusOutput);
  read('freebuff_status', 'Compatibility name for get_freebuff_status. Returns the same connection, authorization, and supported-action report.', {}, readFreebuffStatus, true, statusOutput);

  const requireSessions = async () => { const caps = await adapter.backend.probe(); if (caps.connection === 'unavailable' || caps.connection === 'not_running' || caps.connection === 'not_installed') throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'Freebuff is not available.', JSON.stringify(toErrorShape(new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'Freebuff is not available.')).recovery)); return caps; };

  read('list_projects', 'List project records visible to the selected Freebuff backend. Use a returned project id or path with project file tools.', {}, () => shapeError(async () => { await requireSessions(); return adapter.backend.listProjects(); }));
  read('list_threads', 'List threads visible to Freebuff, optionally filtered to one project id or path. Use get_thread for one thread or get_active_work for nonterminal work.', { projectId: id.optional() }, (args) => shapeError(async () => { await requireSessions(); const threads = await adapter.backend.listThreads(); return args.projectId ? (Array.isArray(threads) ? threads : []).filter((t) => (t as Record<string, unknown>).projectId === args.projectId || (t as Record<string, unknown>).projectPath === args.projectId) : threads; }));
  const threadPageOutput = z.object({ ok: z.literal(true), threads: z.array(z.unknown()), offset: z.number().int(), limit: z.number().int(), totalThreads: z.number().int(), hasMore: z.boolean(), nextOffset: z.number().int().nullable() });
  const visibleThreads = async (projectId?: string): Promise<unknown[]> => {
    await requireSessions();
    const threads = await adapter.backend.listThreads();
    if (!Array.isArray(threads)) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'Freebuff returned an unreadable thread list.');
    return projectId ? threads.filter((entry) => { const thread = asObject(entry); return thread?.projectId === projectId || thread?.projectPath === projectId; }) : threads;
  };
  read('list_threads_page', 'List a bounded page of visible threads, optionally filtered to one project. Continue with nextOffset while hasMore is true; use list_threads for the full list in one response.', { projectId: id.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }, (args) => shapeError(async () => {
    const threads = await visibleThreads(args.projectId);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    const page = threads.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return { ok: true, threads: page, offset, limit, totalThreads: threads.length, hasMore: nextOffset < threads.length, nextOffset: nextOffset < threads.length ? nextOffset : null };
  }), true, threadPageOutput);
  read('get_thread', 'Read metadata for one Freebuff thread, including fields the backend exposes. Use get_thread_messages for conversation text or get_thread_settings for model and reasoning settings.', { threadId: id }, (args) => shapeError(() => adapter.backend.getThread(assertSafeId(args.threadId))));
  const threadSettingsOutput = z.object({
    ok: z.literal(true), threadId: z.string(),
    settings: z.object({ model: z.string().optional(), harnessId: z.string().optional(), reasoningEffort: z.string().nullable().optional() }),
    availableFields: z.array(z.enum(['model', 'harnessId', 'reasoningEffort'])),
    unavailableFields: z.array(z.enum(['model', 'harnessId', 'reasoningEffort'])),
  });
  read('get_thread_settings', 'Read the model, harness, and reasoning effort reported for a thread. Missing fields are reported as unavailable, never inferred.', { threadId: id }, (args) => shapeError(async () => {
    const threadId = assertSafeId(args.threadId);
    const thread = asObject(await adapter.backend.getThread(threadId));
    if (!thread) throw new BridgeError(ErrorCodes.DESKTOP_API_INCOMPATIBLE, 'Freebuff returned unreadable thread settings.', 'Read the thread again or update Freebuff Desktop.');
    const settingFields = ['model', 'harnessId', 'reasoningEffort'] as const;
    const isPresent = (record: Record<string, unknown>, field: typeof settingFields[number]) => field === 'reasoningEffort'
      ? typeof record[field] === 'string' || record[field] === null
      : typeof record[field] === 'string';
    const needsFallback = settingFields.some((field) => !isPresent(thread, field));
    const threadRows = needsFallback ? await adapter.backend.listThreads().catch(() => []) : [];
    const listedThread = Array.isArray(threadRows)
      ? threadRows.map(asObject).find((row) => row?.id === threadId)
      : undefined;
    const settings: { model?: string; harnessId?: string; reasoningEffort?: string | null } = {};
    const availableFields = settingFields.filter((field) => {
      const record = isPresent(thread, field) ? thread : listedThread;
      if (!record || !isPresent(record, field)) return false;
      if (field === 'reasoningEffort') settings.reasoningEffort = record[field] as string | null;
      else settings[field] = record[field] as string;
      return true;
    });
    return {
      ok: true,
      threadId,
      settings,
      availableFields,
      unavailableFields: settingFields.filter((field) => !availableFields.includes(field)),
    };
  }), true, threadSettingsOutput);
  read('get_thread_messages', 'Read all messages that the selected Freebuff backend exposes for one thread. Large conversations can produce large results; use get_thread_messages_page for bounded paging.', { threadId: id }, (args) => shapeError(() => adapter.backend.getMessages(assertSafeId(args.threadId))));
  const messagePageOutput = z.object({ ok: z.literal(true), threadId: z.string(), messages: z.array(z.unknown()), offset: z.number().int(), limit: z.number().int(), totalMessages: z.number().int(), hasMore: z.boolean(), nextOffset: z.number().int().nullable() });
  read('get_thread_messages_page', 'Read a bounded page of messages from one thread. Continue with the returned nextOffset while hasMore is true; use get_thread_messages to retrieve the full history in one response.', { threadId: id, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }, (args) => shapeError(async () => {
    const threadId = assertSafeId(args.threadId);
    const data = await adapter.backend.getMessages(threadId);
    if (!Array.isArray(data)) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'Freebuff returned an unreadable message list for this thread.');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    const messages = data.slice(offset, offset + limit);
    const nextOffset = offset + messages.length;
    return { ok: true, threadId, messages, offset, limit, totalMessages: data.length, hasMore: nextOffset < data.length, nextOffset: nextOffset < data.length ? nextOffset : null };
  }), true, messagePageOutput);
  read('get_active_work', 'Find visible threads whose reported turn state is not idle or terminal. Returns an empty list when no active work is visible; use list_threads to include idle threads.', {}, () => shapeError(async () => {
    await requireSessions();
    const threads = await adapter.backend.listThreads();
    return (Array.isArray(threads) ? threads : []).filter((t) => { const state = (t as Record<string, unknown>).turnState; return typeof state === 'string' && !['idle', 'completed', 'failed', 'cancelled'].includes(state); });
  }));
  read('get_turn', 'Read the bridge’s canonical state and a bounded page of recent events for one turn. Use watch_turn to wait for an update or continue from a later sequence.', { turnId: id, afterSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }, (args) => shapeError(async () => {
    const snapshot = adapter.turns.progressForTurn(assertSafeId(args.turnId), args.afterSequence ?? 0, args.limit ?? 50);
    const turn = adapter.turns.getTurn(assertSafeId(args.turnId));
    return { ok: true, turnId: turn.id, sessionId: turn.sessionId, state: turn.state, backendTurnId: turn.backendTurnId, error: turn.error, snapshot };
  }), false);
  read('get_thread_progress', 'Read a bounded snapshot of events and state tracked by this bridge for one thread. Use watch_thread to wait for the next update.', { threadId: id, afterSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }, (args) => shapeError(async () => adapter.sessions.events.progress(assertSafeId(args.threadId), args.afterSequence ?? 0, args.limit ?? 50)), false);
  read('watch_thread', 'Wait up to 30 seconds for bridge-tracked progress after a sequence number. Poll again with the last event sequence to continue; use get_thread_progress for a non-waiting snapshot.', { threadId: id, afterSequence: z.number().int().nonnegative().optional(), timeoutMs: z.number().int().min(0).max(30000).optional(), limit: z.number().int().min(1).max(100).optional() }, (args) => shapeError(() => adapter.sessions.events.wait(assertSafeId(args.threadId), args.afterSequence ?? 0, args.timeoutMs ?? 30_000, args.limit ?? 50)), false);
  read('get_thread_progress_summary', 'Return one compact bridge-tracked progress snapshot without raw event detail. Use get_thread_progress when event-level data is needed.', { threadId: id }, (args) => shapeError(async () => {
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
  }), false);
  read('watch_turn', 'Wait up to 30 seconds for a canonical turn update. Use the returned sequence to request only newer events; get_turn gives the current state without waiting.', { turnId: id, timeoutMs: z.number().int().min(0).max(30000).optional(), afterSequence: z.number().int().nonnegative().optional() }, (args) => shapeError(() => adapter.turns.waitForTurn(assertSafeId(args.turnId), args.timeoutMs ?? 30_000, args.afterSequence ?? 0)), false);
  read('watch_active_threads', 'Return compact bridge progress snapshots for threads with tracked activity. This does not discover idle or untracked Freebuff threads; use list_threads for backend discovery.', {}, () => shapeError(async () => adapter.sessions.events.activeThreads().map((threadId) => adapter.sessions.events.progress(threadId, 0, 1))), false);
  read('list_project_files', 'List files the bridge permits reading inside a project returned by list_projects. Optionally limit the result to a relative subdirectory.', { projectId: id, relative: z.string().optional() }, (args) => shapeError(async () => {
    const root = await resolveListedProjectRoot(adapter.backend, args.projectId);
    return (adapter.backend.desktop as unknown as { listFiles(root: string, relative?: string): Promise<string[]> }).listFiles(root, args.relative);
  }));
  const readProjectFile = (args: { projectId: string; path: string }) => shapeError(async () => {
    const root = await resolveListedProjectRoot(adapter.backend, args.projectId);
    return (adapter.backend.desktop as unknown as { readFile(root: string, relative: string): Promise<{ path: string; content: string }> }).readFile(root, args.path);
  });
  read('get_project_file', 'Read one safe, redacted file inside a project returned by list_projects. The path must stay inside that project root.', { projectId: id, path: z.string() }, readProjectFile);
  read('read_project_file', 'Compatibility name for get_project_file. Reads one safe, redacted file inside a project returned by list_projects.', { projectId: id, path: z.string() }, readProjectFile);
  read('list_thread_attachments', 'List attachment metadata exposed by the backend that owns this thread. Returns metadata only and does not download attachment contents; the CLI currently does not expose attachments.', { threadId: id }, (args) => shapeError(() => adapter.backend.listAttachments(assertSafeId(args.threadId))));
  const modelCatalogStatusOutput = z.object({ ok: z.literal(true), catalogAvailable: z.literal(false), backend: z.string(), connection: z.string(), note: z.string() });
  const getModelCatalogStatus = () => shapeError(async () => {
    // The Desktop exposes no model-catalog route, and getThread('') is an
    // invalid id that must never be called. Report honestly what is known.
    const caps = await requireSessions();
    return {
      ok: true,
      catalogAvailable: false,
      backend: caps.backend,
      connection: caps.connection,
      note: 'The installed Freebuff backends expose no standalone model-catalog route. Use get_thread_settings to read the current thread model and set_model to request a change.',
    };
  });
  read('get_model_catalog_status', 'Check whether this Freebuff installation exposes a standalone model catalog. The current Desktop and CLI backends do not enumerate models; use get_thread_settings to read a selected thread or set_model to request a change.', {}, getModelCatalogStatus, true, modelCatalogStatusOutput);
  read('list_models', 'Compatibility name for get_model_catalog_status. Reports whether this installation can enumerate models; it does not return a model list.', {}, getModelCatalogStatus, true, modelCatalogStatusOutput);
  const searchThreads = (args: { query: string }) => shapeError(async () => {
    await requireSessions();
    const threads = await adapter.backend.listThreads();
    const q = args.query.toLowerCase();
    return (Array.isArray(threads) ? threads : []).filter((t) => JSON.stringify(t).toLowerCase().includes(q)).slice(0, 100);
  });
  read('search_threads', 'Search visible Freebuff thread metadata using a case-insensitive substring. This does not search message bodies or hidden local history files. The compatibility-shaped result is capped at 100; use search_threads_page when more matches may exist.', { query: z.string().trim().min(1).max(200) }, searchThreads);
  read('search_history', 'Compatibility name for search_threads. Searches visible thread metadata, not conversation messages or hidden local history files. Results are capped at 100; use search_threads_page when more matches may exist.', { query: z.string().trim().min(1).max(200) }, searchThreads);
  const threadSearchPageOutput = z.object({ ok: z.literal(true), query: z.string(), threads: z.array(z.unknown()), offset: z.number().int(), limit: z.number().int(), totalMatches: z.number().int(), hasMore: z.boolean(), nextOffset: z.number().int().nullable() });
  read('search_threads_page', 'Search visible thread metadata and return one bounded page of matches. This does not search message bodies or hidden history; continue with nextOffset while hasMore is true.', { query: z.string().trim().min(1).max(200), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }, (args) => shapeError(async () => {
    const threads = await visibleThreads();
    const query = args.query.toLowerCase();
    const matches = threads.filter((thread) => (JSON.stringify(thread) ?? String(thread)).toLowerCase().includes(query));
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 25;
    const page = matches.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return { ok: true, query: args.query, threads: page, offset, limit, totalMatches: matches.length, hasMore: nextOffset < matches.length, nextOffset: nextOffset < matches.length ? nextOffset : null };
  }), true, threadSearchPageOutput);
  const messageSearchOutput = z.object({
    ok: z.literal(true), threadId: z.string(), query: z.string(),
    matches: z.array(z.object({ index: z.number().int(), role: z.string().optional(), timestamp: z.string().optional(), excerpt: z.string() })),
    matchesInScannedMessages: z.number().int(), scannedMessages: z.number().int(), totalMessages: z.number().int(), truncated: z.boolean(),
  });
  read('search_thread_messages', 'Search messages exposed for one thread. Returns matching message excerpts only, capped at the requested limit; it does not search other threads or hidden history.', { threadId: id, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(50).optional() }, (args) => shapeError(async () => {
    const messages = await adapter.backend.getMessages(assertSafeId(args.threadId));
    if (!Array.isArray(messages)) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'Freebuff returned an unreadable message list for this thread.');
    const query = args.query.toLowerCase();
    const scanned = messages.slice(0, 10_000);
    const maxMatches = args.limit ?? 20;
    const matches: Array<{ index: number; role?: string; timestamp?: string; excerpt: string }> = [];
    let totalMatches = 0;
    let contentTruncated = false;
    for (let index = 0; index < scanned.length; index += 1) {
      const raw = scanned[index];
      const fullText = messageText(raw);
      if (fullText.length > 100_000) contentTruncated = true;
      const text = fullText.slice(0, 100_000);
      const offset = text.toLowerCase().indexOf(query);
      if (offset < 0) continue;
      totalMatches += 1;
      if (matches.length >= maxMatches) continue;
      const message = asObject(raw);
      const start = Math.max(0, offset - 250);
      const excerpt = String(redact(text.slice(start, Math.min(text.length, offset + query.length + 750))));
      matches.push({
        index,
        ...(typeof message?.role === 'string' ? { role: message.role } : {}),
        ...(typeof message?.sentAt === 'string' ? { timestamp: message.sentAt } : typeof message?.timestamp === 'string' ? { timestamp: message.timestamp } : {}),
        excerpt,
      });
    }
    return { ok: true, threadId: args.threadId, query: args.query, matches, matchesInScannedMessages: totalMatches, scannedMessages: scanned.length, totalMessages: messages.length, truncated: totalMatches > matches.length || contentTruncated || messages.length > scanned.length };
  }), true, messageSearchOutput);

  // --- Session/turn lifecycle ---
  const createThread = async (args: { cwd?: string; continueConversationId?: string }) => shapeError(async () => {
    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : (process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd());
    const session = await adapter.sessions.createSession({ cwd, ...(args.continueConversationId ? { continueBackendId: assertSafeId(args.continueConversationId) } : {}) });
    return { ok: true, sessionId: session.id, ...(session.backendSessionId ? { threadId: session.backendSessionId } : {}), backend: session.backend, backendSessionId: session.backendSessionId, backendHandleId: session.backendHandleId, state: session.state };
  });
  const createThreadOutput = z.object({
    ok: z.literal(true), sessionId: z.string(), threadId: z.string().optional(), backend: z.enum(['desktop', 'cli']),
    backendSessionId: z.string().optional(), backendHandleId: z.string().optional(), state: z.string(),
  });
  const createThreadSchema = { cwd: z.string().optional(), continueConversationId: id.optional() };
  write('create_thread', 'Create a bridge session in the selected project, or attach to an existing Freebuff conversation. The result includes a sessionId and, when provided by Freebuff, a threadId.', createThreadSchema, createThread, { outputSchema: createThreadOutput });
  write('start_thread', 'Compatibility name for create_thread. Creates a bridge session or attaches to an existing conversation and returns the identifiers needed by later tools.', createThreadSchema, createThread, { outputSchema: createThreadOutput });

  const sendMessageInput = z.union([
    describeInputs({ text: z.string().min(1).max(100000) }).strict(),
    describeInputs({ sessionId: id, text: z.string().min(1).max(100000) }).strict(),
    describeInputs({ threadId: id, text: z.string().min(1).max(100000) }).strict(),
  ]);
  write('send_message', 'Queue a request on an existing bridge session and return immediately with a turnId. Pass sessionId or threadId, or omit both to create a session in the configured project. Poll get_turn or watch_turn for progress and the final result; Freebuff may edit files or run commands.', sendMessageInput, async (args) => shapeError(async () => {
    const sessionId = await resolveSessionId(adapter, args);
    const { turnId, done } = adapter.turns.startTurnDetached(sessionId, { text: args.text });
    void done.catch(() => undefined);
    const turn = adapter.turns.getTurn(turnId);
    return { ok: true, turnId, sessionId, state: turn.state, note: 'Poll get_turn or watch_turn with this turnId for progress and the final result.' };
  }), { destructiveHint: true });

  write('run_turn', 'Send a request to Freebuff and wait for a terminal turn result while reporting MCP progress. Pass sessionId or threadId, or omit both to create a session in the configured project. Cancellation asks the owning backend to stop; the result distinguishes confirmed stops, waiting states, and rate limits. Freebuff may edit files or run commands.', sendMessageInput, async (args, ctx) => shapeError(async () => {
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
        return { ok: turn.state !== 'failed' && turn.state !== 'rate_limited', turnId: turn.id, sessionId, state: turn.state, backendTurnId: turn.backendTurnId, result: turn.result, ...(turn.error ? { error: turn.error } : {}) };
      } finally {
        unsubscribe();
        adapter.sessions.unregisterController(handle.turn.id);
      }
    } finally {
      ctx.signal.removeEventListener('abort', onClientAbort);
    }
  }), { destructiveHint: true });

  write('stop_turn', 'Cancel a bridge-tracked turn for the given session and ask its owning backend to stop. The result says whether the backend confirmed the stop; a local cancellation alone is not confirmation.', { sessionId: id, turnId: id.optional() }, async (args) => shapeError(async () => {
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
  }), { idempotentHint: true });

  const stopThreadInput = z.union([
    describeInputs({ sessionId: id }).strict(),
    describeInputs({ threadId: id }).strict(),
  ]);
  write('stop_thread', 'Ask Freebuff to stop work for a bridge session or known thread. Supply exactly one of sessionId or threadId; stopping an unknown thread requires creating or attaching a bridge session first.', stopThreadInput, async (args) => shapeError(async () => {
    if (!args.sessionId && !args.threadId) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Pass the sessionId returned by start_thread or a Freebuff threadId.');
    if (args.sessionId && args.threadId) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Pass either sessionId or threadId, not both.');
    // Resolve ownership exactly like set_model does: a bare thread id is
    // wrapped through registerExisting/resolveExisting so CLI conversations
    // stop on the CLI instead of being forced onto the Desktop.
    const session = args.sessionId
      ? adapter.sessions.getSession(assertSafeId(args.sessionId))
      : await findSessionByBackendId(adapter, assertSafeId(args.threadId));
    if (session) { await adapter.backend.stop(adapter.sessions.toBackendSession(session)); return { ok: true }; }
    throw new BridgeError(ErrorCodes.SESSION_NOT_FOUND, 'Stopping requires a bridge session created through start_thread.', 'Call start_thread with the conversation id, then stop_turn.');
  }), { idempotentHint: true });

  write('resume_thread', 'Ask the owning Freebuff backend to resume a paused thread. For CLI conversations outside the current project, pass the original cwd. Resume may continue work that edits files or runs commands, and uncertain outcomes remain marked as unconfirmed.', { threadId: id, sessionId: id.optional(), cwd: z.string().min(1).max(4096).optional() }, async (args) => shapeError(async () => {
    const threadId = assertSafeId(args.threadId);
    if (args.sessionId) {
      const bySession = adapter.sessions.getSession(assertSafeId(args.sessionId));
      if (!bySession) throw new BridgeError(ErrorCodes.SESSION_NOT_FOUND, `Unknown bridge session ${args.sessionId}.`, 'Call create_thread first.');
      if (bySession.backendSessionId && bySession.backendSessionId !== threadId) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'The sessionId and threadId refer to different conversations.');
    }
    const cwd = args.cwd ?? process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd();
    // `threadId` is the required argument: resolve ownership through the same
    // registerExisting/resolveExisting path as set_model, so a CLI
    // conversation id resumes on the CLI instead of defaulting to Desktop.
    const session = args.sessionId
      ? adapter.sessions.getSession(assertSafeId(args.sessionId))
      : await findSessionByBackendId(adapter, threadId, cwd);
    // With no remembered bridge session, a CLI-only install can otherwise
    // misroute an unverified id to the absent Desktop when its chat is under a
    // different project cwd. Surface a CLI-specific recovery hint instead.
    if (session?.backend === 'desktop') {
      const capabilities = await adapter.backend.probe();
      if (capabilities.connection === 'cli_ready') {
        throw new BridgeError(
          ErrorCodes.CLI_SESSION_REJOIN_UNSUPPORTED,
          `The CLI is available, but conversation ${threadId} could not be verified under ${cwd}. Pass its project cwd or create a bridge session for that conversation first.`,
          'Use `resume_thread` with the original project cwd. The bridge will not clear shared message history or session leases.',
        );
      }
    }
    const backendSession: BackendSession = session ? adapter.sessions.toBackendSession(session) : { id: threadId, backend: 'desktop' as const, backendSessionId: threadId, cwd: process.cwd() };
    // Resuming is backend-specific. Route to the owning backend implementation
    // so a CLI slash command cannot be mistaken for Freebuff session rejoin.
    const result = await (adapter.backend as unknown as { resume(session: BackendSession): Promise<BackendTurnResult> }).resume(backendSession);
    if (session) adapter.sessions.reconcileResume(session.id, result);
    return { ok: result.state !== 'failed' && result.state !== 'rate_limited', ...result } as Json;
  }), { destructiveHint: true });

  write('set_model', 'Request a model change for a thread already known to this bridge. The selected backend validates the model; use get_thread_settings to read the reported value afterward.', { threadId: id, model: z.string().min(1).max(200), harnessId: z.string().optional() }, async (args) => shapeError(async () => {
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
  }), { idempotentHint: true });

  write('set_reasoning', 'Request a reasoning effort change for a thread already known to this bridge. Pass null to clear the override; use get_thread_settings to read the reported value afterward.', { threadId: id, effort: z.string().nullable() }, async (args) => shapeError(async () => {
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
  }), { idempotentHint: true });

  read('get_changed_files', 'List unique file paths observed in this bridge’s recent progress events for a thread. This event-derived list may not include earlier or unreported changes.', { threadId: id }, (args) => shapeError(async () => {
    const snapshot = adapter.sessions.events.progress(assertSafeId(args.threadId), 0, 100);
    return { ok: true, threadId: args.threadId, files: snapshot.filesChanged ?? [] };
  }), false);
  read('get_changes', 'Read Freebuff Desktop’s change summary for a thread, including changed paths and line totals when the installed version exposes the route. Use get_diff for per-file patch text.', { threadId: id, scope: z.enum(['all', 'uncommitted']).optional() }, (args) => shapeError(async () => {
    const changes = await desktopChanges(adapter).getChanges(assertSafeId(args.threadId), args.scope ?? 'all');
    return { ok: true, ...(asObject(changes) ?? { changes }) };
  }));

  const diffOutput = z.object({
    ok: z.literal(true), threadId: z.string(), scope: z.enum(['all', 'uncommitted']),
    source: z.enum(['desktop', 'events', 'none']), changeSummaryAvailable: z.boolean(), changedFileCount: z.number().int(),
    files: z.array(z.object({ path: z.string(), adds: z.number().optional(), dels: z.number().optional(), diff: z.string().optional(), binary: z.boolean().optional(), tooLarge: z.boolean().optional(), error: z.string().optional() })),
    requestedFile: z.string().optional(), requestedFileFound: z.boolean().optional(), truncated: z.boolean(), diffAvailable: z.boolean(),
    note: z.string().optional(), branch: z.string().nullable().optional(), totals: z.record(z.string(), z.unknown()).optional(),
  });
  read('get_diff', 'Read actual per-file patch text from Freebuff Desktop when supported. The result identifies whether file paths came from Desktop, bridge events, or no source, and reports when a requested file was not found. Event-derived paths may not cover earlier changes.', { threadId: id, file: z.string().optional(), scope: z.enum(['all', 'uncommitted']).optional() }, (args) => shapeError(async () => {
    const threadId = assertSafeId(args.threadId);
    const scope = args.scope ?? 'all';
    const desktop = desktopChanges(adapter);
    const eventFiles = adapter.sessions.events.progress(threadId, 0, 100).filesChanged ?? [];

    let changes: Record<string, unknown> | undefined;
    try { changes = asObject(await desktop.getChanges(threadId, scope)); } catch { changes = undefined; }

    const desktopSummaryAvailable = Array.isArray(changes?.files);
    const source = desktopSummaryAvailable ? 'desktop' : eventFiles.length ? 'events' : 'none';
    const rawChanged = desktopSummaryAvailable
      ? (changes!.files as unknown[]).flatMap((entry) => { const record = asObject(entry); const path = typeof record?.path === 'string' ? record.path : undefined; return path ? [{ path, adds: typeof record?.adds === 'number' ? record.adds : undefined, dels: typeof record?.dels === 'number' ? record.dels : undefined }] : []; })
      : eventFiles.map((path) => ({ path, adds: undefined as number | undefined, dels: undefined as number | undefined }));
    const changed = [...new Map(rawChanged.map((file) => [file.path, file])).values()];

    const requested = typeof args.file === 'string' && args.file ? args.file : undefined;
    const requestedMatches = requested ? changed.filter((f) => f.path === requested) : changed;
    const targets = requestedMatches.slice(0, MAX_DIFF_FILES);

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

    const notes = [
      ...(!desktopSummaryAvailable && source === 'events' ? ['The Desktop change summary is unavailable; these paths come only from progress events observed by this bridge and may omit earlier changes.'] : []),
      ...(source === 'none' ? ['No Desktop change summary or file events are available for this thread, so the bridge cannot determine whether files changed.'] : []),
      ...(unavailable ? [`${unavailable} file diff(s) could not be read from the Desktop; no diff text is ever invented.`] : []),
    ];

    return {
      ok: true,
      threadId,
      scope,
      source,
      changeSummaryAvailable: desktopSummaryAvailable,
      changedFileCount: changed.length,
      ...(typeof changes?.branch === 'string' || changes?.branch === null ? { branch: changes?.branch } : {}),
      ...(asObject(changes?.totals) ? { totals: changes!.totals } : {}),
      files,
      ...(requested ? { requestedFile: requested, requestedFileFound: requestedMatches.length > 0 } : {}),
      truncated: !requested && changed.length > targets.length,
      diffAvailable: files.some((f) => typeof f.diff === 'string'),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }), true, diffOutput);

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
  if (typeof args.sessionId === 'string' && args.sessionId && typeof args.threadId === 'string' && args.threadId) {
    throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Pass either sessionId or threadId, not both.');
  }
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

async function findSessionByBackendId(adapter: V2Adapter, backendId: string, cwd = process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd()) {
  return adapter.sessions.listSessions().find((s) => s.backendSessionId === backendId) ?? (await adapter.sessions.registerExisting({ backendSessionId: backendId, cwd }));
}

async function resolveListedProjectRoot(backend: FreebuffBackend, projectId: string): Promise<string> {
  if (!backend.listProjects) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'This Freebuff backend cannot list projects.');
  const projects = await backend.listProjects();
  if (!Array.isArray(projects)) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'Freebuff returned an invalid project list.');
  for (const value of projects) {
    const project = asObject(value);
    if (!project) continue;
    const projectPath = typeof project.path === 'string' ? project.path : undefined;
    const id = typeof project.id === 'string' ? project.id : undefined;
    if ((id === projectId || projectPath === projectId) && projectPath) return projectPath;
  }
  throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Project not found in the current Freebuff project list.');
}

export function createDefaultAdapter(): V2Adapter & { dispose(): Promise<void> } {
  const backend = new CompositeBackend();
  const sessions = new SessionManager(backend);
  const turns = new TurnManager(sessions);
  return { backend, sessions, turns, dispose: () => sessions.dispose() };
}

export async function runStdioV2(): Promise<void> {
  const adapter = createDefaultAdapter();
  const server = createV2ServerFromAdapter(adapter);
  const handle = serveStdio(() => server, { legacy: 'serve', maxSubscriptions: 64, onerror: (error) => console.error(error.message) });
  let shutdown: Promise<void> | undefined;
  const cleanup = () => shutdown ??= (async () => { await adapter.dispose(); await handle.close(); })();
  process.once('SIGINT', () => { void cleanup(); });
  process.once('SIGTERM', () => { void cleanup(); });
}

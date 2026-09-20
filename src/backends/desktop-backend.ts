import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafeId, redact, safeProjectPath, safeTextContent, sanitizeFreebuff } from '../security.js';
import { blocked } from '../security.js';
import { SseClient, SseEvent } from '../desktop/sse.js';
import { mapDesktopEvent, safeMetadata } from '../desktop/event-adapter.js';
import { discoverDesktop, invalidateDiscoveryCache, DesktopCandidate } from '../desktop/discovery.js';
import { BackendCapabilities, BackendEventInput, BackendTurnResult, BackendSession, BridgeError, ErrorCodes, FreebuffBackend } from '../bridge/types.js';

const REQUEST_TIMEOUT_MS = 8_000;
const RECOVERABLE = /(fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket)/i;

export interface DesktopBackendOptions {
  /** Explicit base URL (disables broad discovery). */
  baseUrl?: string;
  explicitLaunchId?: string;
}

interface ConnectionState {
  base: URL;
  launchId?: string;
  pid?: number;
  source?: DesktopCandidate['source'];
}

/**
 * Desktop backend: structured HTTP + SSE against the local Freebuff Desktop
 * orchestrator. Reconnects on 401/403/404, 5xx, network errors, and port
 * rotation. liveProgress is 'connected' ONLY when the SSE stream is healthy.
 */
export class DesktopBackend implements FreebuffBackend {
  readonly kind = 'desktop' as const;
  private connection?: ConnectionState;
  private connecting?: Promise<void>;
  private sse?: SseClient;
  private sseConnected = false;
  private lastEventAt?: number;
  private eventListeners = new Set<(event: BackendEventInput) => void>();
  private lastUpstreamId?: string;

  constructor(private options: DesktopBackendOptions = {}) {}

  onBackendEvent(listener: (event: BackendEventInput) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  private async connect(force = false): Promise<void> {
    if (this.connection && !force) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (this.options.baseUrl) {
        this.connection = { base: new URL(this.options.baseUrl), ...(this.options.explicitLaunchId || process.env.FREEBUFF_LAUNCH_ID ? { launchId: this.options.explicitLaunchId ?? process.env.FREEBUFF_LAUNCH_ID } : {}), source: 'explicit' };
      } else {
        invalidateDiscoveryCache();
        const found = await discoverDesktop({ force: true });
        if (!found.candidate) throw new BridgeError(ErrorCodes.DESKTOP_NOT_FOUND, found.reason === 'no_candidates' ? 'No Freebuff Desktop instance was discovered.' : 'Freebuff Desktop was discovered but did not answer health checks.', 'Start Freebuff Desktop, or run freebuff-mcp doctor for details.');
        this.connection = { base: new URL(found.candidate.url), ...(found.candidate.launchId ? { launchId: found.candidate.launchId } : {}), ...(found.candidate.pid ? { pid: found.candidate.pid } : {}), source: found.candidate.source };
      }
      this.startEventStream();
    })();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json', ...(this.connection?.launchId ? { 'x-freebuff-launch-id': this.connection.launchId } : {}) };
  }

  private async request<T>(method: string, pathname: string, body?: unknown, allowReconnect = true): Promise<T> {
    await this.connect();
    if (!this.connection) throw new BridgeError(ErrorCodes.DESKTOP_NOT_FOUND, 'Freebuff Desktop is not connected.');
    try {
      const response = await fetch(new URL(pathname, this.connection.base), { method, headers: this.headers(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        const retriable = [401, 403, 404].includes(response.status) || response.status >= 500;
        if (retriable && allowReconnect) {
          // Authorization rotation or Desktop restart: rediscover and retry once.
          this.connection = undefined;
          this.sseConnected = false;
          await this.connect(true);
          return await this.request<T>(method, pathname, body, false);
        }
        throw new BridgeError(response.status === 401 || response.status === 403 ? ErrorCodes.DESKTOP_AUTH_REQUIRED : ErrorCodes.BACKEND_UNAVAILABLE, `Freebuff Desktop returned HTTP ${response.status} for ${pathname}.`, response.status === 401 || response.status === 403 ? 'Restart Freebuff Desktop or reopen the project so it can issue a fresh launch authorization, then retry.' : undefined);
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (RECOVERABLE.test(String(error)) && allowReconnect) {
        this.connection = undefined;
        this.sseConnected = false;
        await this.connect(true);
        return await this.request<T>(method, pathname, body, false);
      }
      throw error;
    }
  }

  private startEventStream(): void {
    this.sse?.dispose();
    if (!this.connection) return;
    const connection = this.connection;
    const client = new SseClient({
      url: () => new URL('/api/events', connection.base),
      headers: (): Record<string, string> => (connection.launchId ? { 'x-freebuff-launch-id': connection.launchId } : {}),
      lastEventId: () => this.lastUpstreamId,
      onConnectionChange: (connected) => { this.sseConnected = connected; if (connected) this.lastEventAt = Date.now(); },
      onEvent: (event: SseEvent) => {
        this.lastEventAt = Date.now();
        if (event.id) this.lastUpstreamId = event.id;
        this.dispatch(event);
      },
    });
    this.sse = client;
    client.start();
  }

  private dispatch(event: SseEvent): void {
    let payload: unknown;
    try { payload = JSON.parse(event.data); } catch { return; }
    // Snapshot frames carry full thread state; individual updates carry a type.
    const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    const snapshot = record && typeof record.snapshot === 'object' ? record.snapshot as Record<string, unknown> : undefined;
    if (snapshot && Array.isArray(snapshot.threads)) {
      for (const thread of snapshot.threads as Array<Record<string, unknown>>) {
        const threadId = typeof thread.id === 'string' ? thread.id : undefined;
        const turnState = typeof thread.turnState === 'string' ? thread.turnState : undefined;
        if (!threadId || !turnState) continue;
        const type = turnState === 'running' ? 'phase' : turnState === 'completed' ? 'completed' : turnState === 'failed' ? 'failed' : turnState === 'cancelled' ? 'cancelled' : 'phase';
        this.emit({ threadId, type, ...(turnState ? { state: turnState } : {}) });
      }
      return;
    }
    const mapped = mapDesktopEvent(payload, event.event);
    if (!mapped) return;
    this.emit({ threadId: mapped.threadId, type: mapped.type, ...(mapped.phase ? { phase: mapped.phase } : {}), ...(mapped.state ? { state: mapped.state } : {}), ...(mapped.message !== undefined ? { message: mapped.message } : {}), ...(mapped.tool ? { tool: mapped.tool } : {}), ...(mapped.command ? { command: mapped.command } : {}), ...(mapped.files ? { files: mapped.files } : {}), ...(mapped.error ? { error: mapped.error } : {}) });
  }

  private emit(event: BackendEventInput): void {
    for (const listener of this.eventListeners) listener(event);
  }

  async probe(): Promise<BackendCapabilities> {
    try {
      await this.connect();
    } catch (error) {
      const notFound = error instanceof BridgeError && error.code === ErrorCodes.DESKTOP_NOT_FOUND;
      return { backend: 'desktop', connection: notFound ? 'not_running' : 'unavailable', authorization: 'none', liveProgress: 'unavailable', canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: [error instanceof Error ? error.message : 'Desktop unavailable'] };
    }
    if (!this.connection) return { backend: 'desktop', connection: 'unavailable', authorization: 'none', liveProgress: 'unavailable', canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: ['Desktop not connected.'] };
    let writable = false;
    if (this.connection?.launchId) {
      try { const health = await this.request<{ ok?: unknown }>('GET', '/healthz'); writable = health?.ok === true; } catch { writable = false; }
    }
    if (!this.connection) return { backend: 'desktop', connection: 'not_running', authorization: 'none', liveProgress: 'unavailable', canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: ['Desktop connection was lost during the health check.'] };
    const streamHealthy = this.sseConnected && this.lastEventAt !== undefined && Date.now() - this.lastEventAt < 120_000;
    const started = this.sse !== undefined;
    return {
      backend: 'desktop',
      connection: writable ? 'connected_writable' : 'connected_read_only',
      authorization: writable ? 'write_authorized' : this.connection.launchId ? 'read_only' : 'none',
      liveProgress: this.sseConnected ? (streamHealthy || this.lastEventAt !== undefined ? 'connected' : 'connected') : started ? 'stale' : 'unavailable',
      canCreateSession: true,
      canSendMessage: writable,
      canStop: writable,
      canResume: writable,
      canSetModel: writable,
      canSetReasoning: writable,
      notes: [`Desktop connected at ${this.connection.base.origin}${this.connection.pid ? ` (PID ${this.connection.pid})` : ''} via ${this.connection.source ?? 'discovery'}.`, writable ? 'Write authorization verified through the launch-ID health check.' : 'Read-only: launch authorization is missing or the health check failed.', this.sseConnected ? 'Live event stream connected.' : 'Live event stream is connecting or unavailable.'],
    };
  }

  private async assertWritable(): Promise<void> {
    const caps = await this.probe();
    if (!this.connection?.launchId || caps.connection !== 'connected_writable') throw new BridgeError(ErrorCodes.DESKTOP_AUTH_REQUIRED, 'Freebuff Desktop write authorization is unavailable.', 'Restart Freebuff Desktop or reopen the project, then retry.');
  }

  async listProjects(): Promise<unknown> {
    const value = await this.request<unknown>('GET', '/api/projects');
    return redact(value);
  }

  async listThreads(): Promise<unknown> {
    const projects = await this.request<Record<string, unknown>>('GET', '/api/projects');
    return Array.isArray(projects.projects) ? projects.projects : [];
  }

  async getThread(backendSessionId: string): Promise<unknown> {
    const value = await this.request<unknown>('GET', `/api/thread/${encodeURIComponent(assertSafeId(backendSessionId))}`);
    return sanitizeFreebuff(value);
  }

  async getMessages(backendSessionId: string): Promise<unknown> {
    const thread = await this.getThread(backendSessionId);
    const record = thread && typeof thread === 'object' && !Array.isArray(thread) ? thread as Record<string, unknown> : undefined;
    const messages = record && Array.isArray(record.messages) ? record.messages : [];
    return sanitizeFreebuff(messages);
  }

  async sendMessage({ session, text, signal, onEvent }: { session: BackendSession; text: string; signal?: AbortSignal; onEvent?: (event: BackendEventInput) => void | Promise<void> }): Promise<BackendTurnResult> {
    if (!text || text.length > 100_000) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Message must be 1 to 100000 characters.');
    await this.assertWritable();
    const threadId = session.backendSessionId ? assertSafeId(session.backendSessionId) : session.id;
    const unsubscribe = onEvent ? this.onBackendEvent((event) => { if (event.threadId === threadId) void onEvent(event); }) : undefined;
    try {
      const response = await this.request<unknown>('POST', `/api/thread/${encodeURIComponent(threadId)}/message`, { text });
      if (onEvent) for (const listener of this.eventListeners) { void listener({ threadId, type: 'phase', state: 'submitted' }); break; }
      void signal; // The Desktop manages turn lifetime; the request completes when accepted.
      return { state: 'completed', result: redact(response) };
    } finally {
      unsubscribe?.();
    }
  }

  async stop(session: BackendSession): Promise<void> {
    await this.assertWritable();
    const threadId = assertSafeId(session.backendSessionId ?? session.id);
    await this.request('POST', `/api/thread/${encodeURIComponent(threadId)}/stop`, {});
  }

  async resume(session: BackendSession): Promise<BackendTurnResult> {
    await this.assertWritable();
    const threadId = assertSafeId(session.backendSessionId ?? session.id);
    const response = await this.request<unknown>('POST', `/api/thread/${encodeURIComponent(threadId)}/resume`, {});
    return { state: 'completed', result: redact(response) };
  }

  async setModel(session: BackendSession, model: string, harnessId = 'codebuff'): Promise<unknown> {
    await this.assertWritable();
    const threadId = assertSafeId(session.backendSessionId ?? session.id);
    if (!model || model.length > 200) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Invalid model.');
    return redact(await this.request('POST', `/api/thread/${encodeURIComponent(threadId)}/agent`, { model, harnessId }));
  }

  async setReasoning(session: BackendSession, effort: string | null): Promise<unknown> {
    await this.assertWritable();
    const threadId = assertSafeId(session.backendSessionId ?? session.id);
    return redact(await this.request('POST', `/api/thread/${encodeURIComponent(threadId)}/effort`, { effort }));
  }

  async listAttachments(backendSessionId: string): Promise<unknown> {
    return sanitizeFreebuff(await this.request('GET', `/api/thread/${encodeURIComponent(assertSafeId(backendSessionId))}/attachment`));
  }

  async listFiles(projectRoot: string, relative = '.'): Promise<string[]> {
    const base = await fs.realpath(projectRoot);
    const dir = relative === '.' ? base : await fs.realpath(path.resolve(base, relative));
    const rel = path.relative(base, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((part) => blocked.test(part))) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Path escapes the Freebuff project.');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && !blocked.test(entry.name)).map((entry) => path.relative(base, path.join(dir, entry.name)));
  }

  async readFile(projectRoot: string, relative: string): Promise<{ path: string; content: string }> {
    const file = await safeProjectPath(projectRoot, relative);
    return { path: relative, content: safeTextContent(await fs.readFile(file), file) };
  }

  dispose(): void {
    this.sse?.dispose();
    this.sse = undefined;
    this.sseConnected = false;
    this.connection = undefined;
  }
}

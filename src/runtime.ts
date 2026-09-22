import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  Capabilities,
  Json,
  ProjectSummary,
  ThreadDetail,
  ThreadProgressEvent,
  ThreadProgressKind,
  ThreadProgressSnapshot,
  ThreadSummary,
} from './types.js';
import { assertSafeId, blocked, redact, safeProjectPath, safeTextContent, sanitizeFreebuff } from './security.js';
import { CliPtyManager, cliTurnStateString, findFreebuffCli } from './pty.js';
// Canonical Desktop discovery and live-event plumbing. The legacy MCP/HTTP
// adapters reuse exactly these implementations, so Desktop discovery (handoff
// file, explicit URL, readiness metadata, process env, log hints, and the
// deliberately narrow listener fallback) and SSE parsing exist in ONE place.
import { discoverDesktopCandidate } from './desktop/discovery.js';
import type { DesktopCandidate } from './desktop/discovery.js';
import { SseClient } from './desktop/sse.js';
import type { SseEvent } from './desktop/sse.js';
import { mapDesktopEvent, safeMetadata } from './desktop/event-adapter.js';
import type { MappedDesktopEvent } from './desktop/event-adapter.js';
import { EventStore } from './bridge/event-store.js';
import type { ThreadProgressSnapshot as CanonicalProgressSnapshot } from './bridge/event-store.js';
import type { BridgeEvent, BridgeEventType, BridgePhase } from './bridge/types.js';

export { discoverDesktopCandidate };

export interface Runtime {
  dispose?(): void;
  capabilities(): Promise<Capabilities>;
  listProjects(): Promise<ProjectSummary[]>;
  listThreads(projectId?: string): Promise<ThreadSummary[]>;
  getThread(id: string): Promise<ThreadDetail>;
  getMessages(id: string): Promise<Json>;
  activeWork(id?: string): Promise<Json>;
  getThreadProgress(id: string, afterSequence?: number, limit?: number): Promise<ThreadProgressSnapshot>;
  watchThread(id: string, afterSequence?: number, timeoutMs?: number, limit?: number): Promise<ThreadProgressSnapshot>;
  getThreadProgressSummary(id: string): Promise<ThreadProgressSnapshot>;
  watchActiveThreads(): Promise<ThreadProgressSnapshot[]>;
  listFiles(projectId: string, relative?: string): Promise<string[]>;
  readFile(projectId: string, relative: string): Promise<{ path: string; content: string }>;
  listAttachments(id: string): Promise<Json>;
  sendMessage(id: string, text: string): Promise<Json>;
  stop(id: string): Promise<Json>;
  resume(id: string): Promise<Json>;
  listModels(): Promise<Json>;
  searchHistory(query: string): Promise<Json>;
  setModel(id: string, model: string, harnessId?: string): Promise<Json>;
  setReasoning(id: string, effort: string | null): Promise<Json>;
  onProgress?(listener: (threadId: string) => void): () => void;
  createSession?(cwd: string): Promise<string>;
}

function envRoot(): string { return process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd(); }
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function asString(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function cliProjectKey(root: string): string { return process.env.FREEBUFF_PROJECT_KEY ?? `${path.basename(root)}--${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12)}`; }
function cliChatsRoots(root: string): string[] { const base = path.join(os.homedir(), '.config', 'manicode', 'projects'); return [path.join(base, cliProjectKey(root), 'chats'), path.join(base, path.basename(root), 'chats')]; }
async function readLocalJson(file: string): Promise<any | undefined> { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return undefined; } }
async function cliHistory(root: string): Promise<Array<{ id: string; meta: any; messages: Json[]; state: any }>> {
  const out: Array<{ id: string; meta: any; messages: Json[]; state: any }> = [];
  for (const chats of cliChatsRoots(root)) try {
    for (const entry of await fs.readdir(chats, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9._:-]{1,200}$/.test(entry.name)) continue;
      const dir = path.join(chats, entry.name); const meta = await readLocalJson(path.join(dir, 'chat-meta.json')); const messages = await readLocalJson(path.join(dir, 'chat-messages.json')); const state = await readLocalJson(path.join(dir, 'run-state.json'));
      if (meta && Array.isArray(messages)) out.push({ id: entry.name, meta, messages: sanitizeFreebuff(messages) as Json[], state: sanitizeFreebuff(state ?? {}) });
    }
  } catch { /* CLI history may not exist yet */ }

  return out.sort((a, b) => a.id < b.id ? 1 : -1);
}

// ---------------------------------------------------------------------------
// Canonical bridge events -> legacy progress events
// ---------------------------------------------------------------------------

const KIND_BY_TYPE: Record<BridgeEventType, ThreadProgressKind> = {
  queued: 'turn_state',
  turn_started: 'turn_state',
  phase: 'turn_state',
  assistant_delta: 'assistant_text',
  assistant_message: 'assistant_text',
  tool_started: 'tool_start',
  tool_finished: 'tool_output',
  file_changed: 'file_change',
  command_started: 'tool_start',
  command_finished: 'tool_output',
  waiting_for_user: 'turn_state',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  connection_state: 'turn_state',
  unknown: 'unknown',
};

const PHASE_BY_BRIDGE_PHASE: Record<BridgePhase, NonNullable<ThreadProgressEvent['phase']>> = {
  planning: 'planning',
  reading_files: 'reading_files',
  editing_files: 'editing_files',
  running_command: 'running_command',
  running_tests: 'running_tests',
  reviewing: 'reviewing_changes',
  waiting_for_input: 'waiting_for_input',
  completed: 'completed',
  failed: 'failed',
};

function toLegacyPhase(phase: BridgePhase | undefined): ThreadProgressEvent['phase'] | undefined {
  return phase ? PHASE_BY_BRIDGE_PHASE[phase] : undefined;
}

function toLegacyEvent(event: BridgeEvent): ThreadProgressEvent {
  return {
    sequence: event.sequence,
    threadId: event.threadId,
    timestamp: event.timestamp,
    kind: KIND_BY_TYPE[event.type] ?? 'unknown',
    phase: toLegacyPhase(event.phase),
    state: event.state,
    tool: event.tool,
    command: event.command,
    text: event.message,
    files: event.files,
    error: event.error,
    raw: event.metadata === undefined ? undefined : event.metadata as unknown as Json,
  };
}

function toLegacySnapshot(page: CanonicalProgressSnapshot): ThreadProgressSnapshot {
  return {
    threadId: page.threadId,
    currentState: page.currentState,
    events: page.events.map(toLegacyEvent),
    nextSequence: page.nextSequence,
    connected: page.connected,
    stale: page.stale,
    latestEventAt: page.latestEventAt,
    activeTool: page.activeTool,
    filesChanged: page.filesChanged,
    phase: toLegacyPhase(page.phase),
    lastMeaningfulUpdate: page.lastMeaningfulUpdate,
    lastError: page.lastError,
    secondsSinceLastEvent: page.secondsSinceLastEvent,
  };
}

export class DesktopOrchestratorRuntime implements Runtime {
  private base: URL;
  private readonly explicitBase?: string;
  private launchId?: string;
  private caps?: Capabilities;
  private capsAt = 0;
  private refreshing?: Promise<Capabilities>;
  /** Canonical bounded event store — the single live-progress implementation. */
  private readonly store = new EventStore();
  private sse?: SseClient;
  private streamKey?: string;
  private lastEventAt?: number;
  private readonly progressListeners = new Set<(threadId: string) => void>();
  private readonly unsubscribeStore: () => void;

  constructor(base?: string) {
    this.explicitBase = base;
    this.base = new URL(base ?? 'http://127.0.0.1');
    this.unsubscribeStore = this.store.subscribe((threadId) => { for (const listener of this.progressListeners) listener(threadId); });
  }

  /** Live-progress truth comes from the event stream itself, never from HTTP success. */
  private liveProgress(): 'connected' | 'stale' | 'unavailable' {
    if (this.store.isConnected) return 'connected';
    return this.sse ? 'stale' : 'unavailable';
  }

  private invalidateConnection(): void {
    this.caps = undefined;
    this.capsAt = 0;
    this.launchId = undefined;
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(new URL(pathname, this.base), {
        method,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.launchId ? { 'x-freebuff-launch-id': this.launchId } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Freebuff returned HTTP ${response.status}`);
      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async refreshDesktopConnection(): Promise<Capabilities> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      this.invalidateConnection();
      const candidate: DesktopCandidate | null = this.explicitBase
        ? { url: this.explicitBase, source: 'explicit', ...(process.env.FREEBUFF_LAUNCH_ID ? { launchId: process.env.FREEBUFF_LAUNCH_ID } : {}) }
        : await discoverDesktopCandidate();
      if (!candidate) {
        this.stopEventStream();
        this.caps = { product: 'unknown', signedIn: 'unknown', orchestrator: false, readOnly: true, endpoints: [], status: 'not_found', liveProgress: 'unavailable', selectedRuntime: 'none', notes: ['No Freebuff Desktop connection was discovered.'] };
        this.capsAt = Date.now();
        return this.caps;
      }
      this.base = new URL(candidate.url);
      this.launchId = candidate.launchId;
      try {
        const projects = await this.request<unknown>('GET', '/api/projects');
        const record = asRecord(projects);
        if (!record || !Array.isArray(record.projects)) throw new Error('invalid /api/projects response');
        let writable = false;
        if (this.launchId) {
          try {
            const health = await this.request<unknown>('GET', '/healthz');
            writable = asRecord(health)?.['ok'] === true;
          } catch { this.invalidateConnection(); }
        }
        const liveProgress = this.liveProgress();
        this.caps = {
          product: 'desktop',
          signedIn: 'unknown',
          orchestrator: true,
          readOnly: !writable,
          status: writable ? 'desktop_writable' : 'desktop_read_only',
          liveProgress,
          selectedRuntime: 'desktop',
          endpoints: ['/api/projects', '/api/thread/:id', '/api/thread/:id/attachment', '/api/events', ...(writable ? ['/api/thread/:id/message', '/api/thread/:id/stop', '/api/thread/:id/resume', '/api/thread/:id/agent', '/api/thread/:id/effort'] : [])],
          notes: [
            `Desktop connected at ${candidate.url}${candidate.pid ? ` (PID ${candidate.pid})` : ''}.`,
            writable ? 'Desktop connected with verified writes through health checks.' : 'Desktop connected read only because launch authorization is missing or stale.',
            liveProgress === 'connected' ? 'Live event stream connected.' : 'Live progress reconnects when the Desktop connection changes.',
          ],
        };
        this.capsAt = Date.now();
        this.startEventStream();
        return this.caps;
      } catch (error) {
        this.stopEventStream();
        this.caps = { product: 'unknown', signedIn: 'unknown', orchestrator: false, readOnly: true, endpoints: [], status: 'not_found', liveProgress: 'unavailable', selectedRuntime: 'none', notes: [`Desktop discovery reached ${candidate.url}, but its response was invalid or unavailable. ${error instanceof Error ? error.message : 'Unknown error'}`] };
        this.capsAt = Date.now();
        return this.caps;
      }
    })();
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }

  async capabilities(): Promise<Capabilities> {
    // Live-progress truth is recomputed on every call so it always reflects the
    // event stream's current health rather than a cached snapshot.
    if (this.caps && Date.now() - this.capsAt < 3000) return { ...this.caps, liveProgress: this.liveProgress() };
    const refreshed = await this.refreshDesktopConnection();
    return { ...refreshed, liveProgress: this.liveProgress() };
  }

  private async requestWithRefresh<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    try {
      return await this.request<T>(method, pathname, body);
    } catch (error) {
      if (!/HTTP (401|403|404)/.test(String(error))) throw error;
      this.invalidateConnection();
      await this.refreshDesktopConnection();
      return await this.request<T>(method, pathname, body);
    }
  }

  private startEventStream(): void {
    const key = `${this.base.origin}|${this.launchId ?? ''}`;
    if (this.sse && this.streamKey === key) return;
    this.stopEventStream();
    this.streamKey = key;
    const client = new SseClient({
      url: () => new URL('/api/events', this.base),
      // Read the launch id lazily so an authorization rotation is picked up on reconnect.
      headers: (): Record<string, string> => (this.launchId ? { 'x-freebuff-launch-id': this.launchId } : {}),
      onConnectionChange: (connected) => { this.store.setConnected(connected); if (connected) this.lastEventAt = Date.now(); },
      onEvent: (event) => { this.lastEventAt = Date.now(); this.ingest(event); },
    });
    this.sse = client;
    client.start();
  }

  private stopEventStream(): void {
    this.sse?.dispose();
    this.sse = undefined;
    this.streamKey = undefined;
    this.store.setConnected(false);
  }

  /** Timestamp of the most recent live event (diagnostics). */
  lastLiveEventAt(): string | undefined {
    return this.lastEventAt ? new Date(this.lastEventAt).toISOString() : undefined;
  }

  private ingest(event: SseEvent): void {
    let payload: unknown;
    try { payload = JSON.parse(event.data); } catch { return; }
    const record = asRecord(payload);
    // Snapshot frames carry full thread state; individual updates carry a type.
    const snapshot = record && typeof record.snapshot === 'object' ? asRecord(record.snapshot) : undefined;
    if (snapshot && Array.isArray(snapshot.threads)) {
      for (const value of snapshot.threads as unknown[]) {
        const thread = asRecord(value);
        const threadId = asString(thread?.id);
        const turnState = asString(thread?.turnState);
        if (!threadId || !turnState) continue;
        const type: BridgeEventType = turnState === 'completed' ? 'completed' : turnState === 'failed' ? 'failed' : turnState === 'cancelled' ? 'cancelled' : 'phase';
        this.appendLive({ threadId, type, state: turnState });
      }
      return;
    }
    const mapped = mapDesktopEvent(payload, event.event);
    if (!mapped) return;
    this.appendLive({ ...mapped, metadata: safeMetadata(payload) });
  }

  private appendLive(event: MappedDesktopEvent): void {
    const threadId = event.threadId;
    this.store.append({
      sessionId: `live:${threadId}`,
      turnId: `live:${threadId}`,
      threadId,
      type: event.type,
      ...(event.phase ? { phase: event.phase } : {}),
      ...(event.state ? { state: event.state } : {}),
      ...(event.message !== undefined ? { message: event.message } : {}),
      ...(event.tool ? { tool: event.tool } : {}),
      ...(event.command ? { command: event.command } : {}),
      ...(event.files ? { files: event.files } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
  }

  private snapshot(threadId: string, afterSequence = 0, limit = 50): ThreadProgressSnapshot {
    return toLegacySnapshot(this.store.progress(threadId, afterSequence, limit));
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const record = asRecord(await this.request<unknown>('GET', '/api/projects'));
    if (!record || !Array.isArray(record.projects)) throw new Error('Invalid Freebuff /api/projects response');
    return record.projects.flatMap((value) => {
      const project = asRecord(value);
      const projectPath = asString(project?.path);
      return projectPath ? [{ id: projectPath, path: projectPath, name: path.basename(projectPath), metadata: redact(project as Record<string, Json>) as Json }] : [];
    });
  }

  async listThreads(projectId?: string): Promise<ThreadSummary[]> {
    const projects = await this.listProjects();
    return projects.filter((p) => !projectId || p.id === projectId || p.path === projectId).flatMap((p) => {
      const raw = asRecord(p.metadata);
      const threads = Array.isArray(raw?.threads) ? raw.threads : [];
      return threads.flatMap((value) => {
        const thread = asRecord(value);
        const id = asString(thread?.id);
        if (!id) return [];
        return [{ id, projectId: p.id, title: asString(thread?.title), state: asString(thread?.turnState), model: asString(thread?.model), metadata: redact(thread as Record<string, Json>) as Json }];
      });
    });
  }

  async getThread(id: string): Promise<ThreadDetail> {
    const payload = asRecord(await this.request<unknown>('GET', `/api/thread/${encodeURIComponent(assertSafeId(id))}`));
    // The Desktop returns `{ thread, messages, items }`; unwrap it so callers
    // see the thread fields directly.
    const value = asRecord(payload?.thread) ?? payload;
    if (!value) throw new Error('Invalid Freebuff thread response');
    const threadId = asString(value.id) ?? assertSafeId(id);
    const messages = payload && Array.isArray(payload.messages) ? payload.messages : Array.isArray(value.messages) ? value.messages : undefined;
    return {
      id: threadId,
      projectId: asString(value.projectId) ?? asString(value.projectPath),
      title: asString(value.title),
      state: asString(value.turnState),
      model: asString(value.model),
      messages: messages ? sanitizeFreebuff(messages) as Json[] : undefined,
      activeWork: (value.activeWork ?? payload?.items) === undefined ? undefined : sanitizeFreebuff(value.activeWork ?? payload?.items) as Json,
      live: this.snapshot(threadId, 0, 1),
      metadata: redact(value as Record<string, Json>) as Json,
    };
  }

  async getMessages(id: string): Promise<Json> {
    const thread = await this.getThread(id);
    return sanitizeFreebuff(thread.messages ?? []) as Json;
  }

  async activeWork(id?: string): Promise<Json> {
    const threads = await this.listThreads();
    return threads
      .filter((t) => (!id || t.id === id) && t.state && t.state !== 'idle')
      .map((t) => ({ ...t, live: this.snapshot(t.id, 0, 1) })) as unknown as Json;
  }

  async getThreadProgress(id: string, afterSequence = 0, limit = 50): Promise<ThreadProgressSnapshot> {
    const safe = assertSafeId(id);
    await this.capabilities();
    return this.snapshot(safe, afterSequence, limit);
  }

  async watchThread(id: string, afterSequence = 0, timeoutMs = 30_000, limit = 50): Promise<ThreadProgressSnapshot> {
    const safe = assertSafeId(id);
    await this.capabilities();
    return toLegacySnapshot(await this.store.wait(safe, afterSequence, timeoutMs, limit));
  }

  async getThreadProgressSummary(id: string): Promise<ThreadProgressSnapshot> {
    const safe = assertSafeId(id);
    await this.capabilities();
    return { ...this.snapshot(safe, 0, 1), events: [] };
  }

  async watchActiveThreads(): Promise<ThreadProgressSnapshot[]> {
    await this.capabilities();
    const known = new Set(this.store.activeThreads());
    try {
      const threads = await this.listThreads();
      for (const thread of threads) if (thread.state && !['idle', 'completed', 'failed', 'cancelled'].includes(thread.state)) known.add(thread.id);
    } catch { /* progress remains useful if the snapshot endpoint is temporarily unavailable */ }
    return [...known].map((threadId) => this.snapshot(threadId, 0, 1));
  }

  async listFiles(projectId: string, relative = '.'): Promise<string[]> {
    const project = (await this.listProjects()).find((x) => x.id === projectId || x.path === projectId);
    if (!project) throw new Error('Project not found');
    const root = await fs.realpath(project.path);
    const dir = relative === '.' ? root : await fs.realpath(path.resolve(root, relative));
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((part) => blocked.test(part))) throw new Error('Path escapes the Freebuff project');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && !blocked.test(e.name)).map((e) => path.relative(root, path.join(dir, e.name)));
  }

  async readFile(projectId: string, relative: string): Promise<{ path: string; content: string }> {
    const project = (await this.listProjects()).find((x) => x.id === projectId || x.path === projectId);
    if (!project) throw new Error('Project not found');
    const file = await safeProjectPath(project.path, relative);
    return { path: relative, content: safeTextContent(await fs.readFile(file), file) };
  }

  /**
   * Attachments come from the thread's own messages. The Desktop
   * `/attachment` route requires a `path` parameter and returns one file, so it
   * cannot serve a listing.
   */
  async listAttachments(id: string): Promise<Json> {
    const thread = await this.getThread(assertSafeId(id));
    const attachments: Json[] = [];
    for (const message of thread.messages ?? []) {
      const record = asRecord(message);
      const list = record && Array.isArray(record.attachments) ? record.attachments : [];
      for (const attachment of list) attachments.push(sanitizeFreebuff(attachment) as Json);
    }
    return attachments as unknown as Json;
  }

  private async assertWritable(): Promise<void> {
    const caps = await this.refreshDesktopConnection();
    if (!this.launchId || caps.readOnly) throw new Error('Freebuff Desktop writes are unavailable');
  }

  async sendMessage(id: string, text: string): Promise<Json> {
    await this.assertWritable();
    if (!text || text.length > 100000) throw new Error('Message must be 1 to 100000 characters');
    return redact(await this.requestWithRefresh('POST', `/api/thread/${encodeURIComponent(assertSafeId(id))}/message`, { text })) as Json;
  }

  async stop(id: string): Promise<Json> {
    await this.assertWritable();
    return redact(await this.requestWithRefresh('POST', `/api/thread/${encodeURIComponent(assertSafeId(id))}/stop`, {})) as Json;
  }

  async resume(id: string): Promise<Json> {
    await this.assertWritable();
    return redact(await this.requestWithRefresh('POST', `/api/thread/${encodeURIComponent(assertSafeId(id))}/resume`, {})) as Json;
  }

  async listModels(): Promise<Json> {
    return { note: 'The installed Desktop does not expose a standalone model-catalog route. Use the current thread model and set_model validation.' };
  }

  async searchHistory(query: string): Promise<Json> {
    const q = query.trim().toLowerCase();
    if (!q || q.length > 200) throw new Error('Query must be 1 to 200 characters');
    const projects = await this.listProjects();
    const results: Json[] = [];
    for (const project of projects) {
      const raw = asRecord(project.metadata);
      const threads = Array.isArray(raw?.threads) ? raw.threads : [];
      for (const value of threads) {
        const thread = asRecord(value);
        const threadId = asString(thread?.id);
        if (threadId && JSON.stringify(thread).toLowerCase().includes(q)) results.push({ projectId: project.id, threadId, title: asString(thread?.title) ?? '', state: asString(thread?.turnState) ?? '' });
      }
    }
    return results.slice(0, 100);
  }

  async setModel(id: string, model: string, harnessId = 'codebuff'): Promise<Json> {
    await this.assertWritable();
    if (model.length > 200) throw new Error('Invalid model');
    return redact(await this.requestWithRefresh('POST', `/api/thread/${encodeURIComponent(assertSafeId(id))}/agent`, { model, harnessId })) as Json;
  }

  async setReasoning(id: string, effort: string | null): Promise<Json> {
    await this.assertWritable();
    return redact(await this.requestWithRefresh('POST', `/api/thread/${encodeURIComponent(assertSafeId(id))}/effort`, { effort })) as Json;
  }

  dispose(): void {
    this.stopEventStream();
    this.unsubscribeStore();
    this.progressListeners.clear();
  }

  onProgress(listener: (threadId: string) => void): () => void {
    this.progressListeners.add(listener);
    return () => { this.progressListeners.delete(listener); };
  }
}

export class ReadOnlyRuntime extends DesktopOrchestratorRuntime {
  override async capabilities(): Promise<Capabilities> {
    const caps = await super.capabilities();
    return { ...caps, readOnly: true, notes: [...caps.notes, 'This MCP process is operating in read-only mode.'] };
  }
  override async sendMessage(_id: string, _text: string): Promise<Json> { throw new Error('Freebuff is unavailable or read-only'); }
  override async stop(_id: string): Promise<Json> { throw new Error('Freebuff is unavailable or read-only'); }
  override async resume(_id: string): Promise<Json> { throw new Error('Freebuff is unavailable or read-only'); }
  override async setModel(_id: string, _model: string, _harnessId?: string): Promise<Json> { throw new Error('Freebuff is unavailable or read-only'); }
  override async setReasoning(_id: string, _effort: string | null): Promise<Json> { throw new Error('Freebuff is unavailable or read-only'); }
  override async getThreadProgress(id: string, afterSequence = 0, limit = 50): Promise<ThreadProgressSnapshot> { return super.getThreadProgress(id, afterSequence, limit); }
  override async watchThread(id: string, afterSequence = 0, timeoutMs = 30_000, limit = 50): Promise<ThreadProgressSnapshot> { return super.watchThread(id, afterSequence, timeoutMs, limit); }
  override async getThreadProgressSummary(id: string): Promise<ThreadProgressSnapshot> { return super.getThreadProgressSummary(id); }
  override async watchActiveThreads(): Promise<ThreadProgressSnapshot[]> { return super.watchActiveThreads(); }
}

export class CliPtyRuntime implements Runtime {
  private manager = new CliPtyManager();
  private root = envRoot();

  async capabilities(): Promise<Capabilities> {
    const cli = await findFreebuffCli();
    const available = Boolean(cli);
    return {
      product: 'cli', signedIn: 'unknown', orchestrator: false, readOnly: true,
      status: available ? 'cli_ready' : 'cli_unavailable', liveProgress: 'unavailable', selectedRuntime: 'cli',
      actions: { sendMessage: false, stop: false, resume: false, setModel: false, setReasoning: false },
      endpoints: available ? ['managed PTY (legacy read-only catalog)'] : [],
      notes: [available
        ? `CLI available at ${path.basename(cli!)}. Deprecated serve-v1 does not advertise CLI writes without authenticated PTY proof; use \`freebuff-mcp serve\` for the canonical writable CLI backend.`
        : 'CLI was selected but is not installed or not on PATH.'],
    };
  }

  async listProjects(): Promise<ProjectSummary[]> { return [{ id: this.root, path: this.root, name: path.basename(this.root) }]; }

  async listThreads(): Promise<ThreadSummary[]> {
    return (await cliHistory(this.root)).map((c) => ({
      id: c.id, projectId: this.root,
      title: typeof c.meta.firstPrompt === 'string' ? c.meta.firstPrompt : 'Managed Freebuff CLI session',
      state: c.state && typeof c.state === 'object' ? cliTurnStateString(c.state as Record<string, unknown>) : undefined,
      metadata: { messageCount: c.meta.messageCount, conversationId: c.id },
    }));
  }

  async getThread(id: string): Promise<ThreadDetail> {
    const safe = assertSafeId(id);
    const c = (await cliHistory(this.root)).find((x) => x.id === safe);
    if (c) return { id: safe, projectId: this.root, title: typeof c.meta.firstPrompt === 'string' ? c.meta.firstPrompt : 'Managed Freebuff CLI session', messages: c.messages, metadata: { messageCount: c.meta.messageCount, conversationId: safe } };
    return { id: safe, projectId: this.root, title: 'Managed Freebuff CLI session', metadata: redact(this.manager.snapshot(safe)) as Json };
  }

  async getMessages(id: string): Promise<Json> {
    const c = (await cliHistory(this.root)).find((x) => x.id === assertSafeId(id));
    return c ? c.messages : redact(this.manager.snapshot(id)) as Json;
  }

  async activeWork(id?: string): Promise<Json> { return id ? redact(this.manager.snapshot(id)) as Json : []; }

  async getThreadProgress(id: string): Promise<ThreadProgressSnapshot> { assertSafeId(id); return { threadId: id, events: [], connected: false, stale: true }; }
  async watchThread(id: string): Promise<ThreadProgressSnapshot> { return this.getThreadProgress(id); }
  async getThreadProgressSummary(id: string): Promise<ThreadProgressSnapshot> { return this.getThreadProgress(id); }
  async watchActiveThreads(): Promise<ThreadProgressSnapshot[]> { return []; }

  async listFiles(_projectId: string, relative = '.'): Promise<string[]> {
    const root = await fs.realpath(this.root);
    const dir = relative === '.' ? root : await fs.realpath(path.resolve(root, relative));
    const rel = path.relative(root, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).some((part) => blocked.test(part))) throw new Error('Path escapes the Freebuff project');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && !blocked.test(e.name)).map((e) => path.relative(root, path.join(dir, e.name)));
  }

  async readFile(_projectId: string, relative: string): Promise<{ path: string; content: string }> {
    const file = await safeProjectPath(this.root, relative);
    return { path: relative, content: safeTextContent(await fs.readFile(file), file) };
  }

  async listAttachments(_id: string): Promise<Json> { return []; }
  async sendMessage(id: string, text: string): Promise<Json> { return redact(await this.manager.send(id, text, this.root, assertSafeId(id))) as Json; }
  async hasConversation(id: string, cwd = this.root): Promise<boolean> { return (await cliHistory(cwd)).some((c) => c.id === assertSafeId(id)); }
  async sendMessageInProject(id: string, text: string, cwd: string, continueId?: string): Promise<Json> { return redact(await this.manager.send(id, text, cwd, continueId)) as Json; }
  async sendNewMessageInProject(id: string, text: string, cwd: string): Promise<Json> { return redact(await this.manager.send(id, text, cwd)) as Json; }
  async stop(id: string): Promise<Json> { return redact(this.manager.stop(id)) as Json; }
  async resume(id: string): Promise<Json> { return redact(await this.manager.send(id, '/resume', this.root, assertSafeId(id))) as Json; }
  async listModels(): Promise<Json> { return { note: 'Use the Freebuff CLI /model picker inside a managed PTY session.' }; }

  async searchHistory(query: string): Promise<Json> {
    const q = query.trim().toLowerCase();
    if (!q || q.length > 200) throw new Error('Query must be 1 to 200 characters');
    return (await cliHistory(this.root)).filter((c) => JSON.stringify(c).toLowerCase().includes(q)).slice(0, 100).map((c) => ({ threadId: c.id, title: c.meta.firstPrompt, state: c.state }));
  }

  async setModel(id: string, model: string): Promise<Json> { return redact(await this.manager.send(id, `/model ${model}`, this.root, assertSafeId(id))) as Json; }
  async setReasoning(id: string, effort: string | null): Promise<Json> { return redact(await this.manager.send(id, `/reasoning ${effort ?? ''}`, this.root, assertSafeId(id))) as Json; }
  dispose(): void { this.manager.dispose(); }
  async createSession(cwd: string): Promise<string> { return `cli-${createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 24)}-${Date.now()}`; }
}

export class HybridRuntime implements Runtime {
  private cli = new CliPtyRuntime();
  private cliAvailable = false;
  constructor(private desktop: DesktopOrchestratorRuntime, cli?: CliPtyRuntime) { if (cli) this.cli = cli; }

  async capabilities(): Promise<Capabilities> {
    const caps = await this.desktop.capabilities();
    this.cliAvailable = Boolean(await findFreebuffCli());
    if (!caps.orchestrator || !this.cliAvailable) return caps;
    if (caps.readOnly) {
      return {
        ...caps, readOnly: true, selectedRuntime: 'hybrid',
        actions: { sendMessage: false, stop: false, resume: false, setModel: false, setReasoning: false },
        endpoints: [...caps.endpoints, 'managed CLI PTY present (legacy writes not advertised)'],
        notes: [...caps.notes, 'CLI fallback is installed, but deprecated serve-v1 does not advertise writes from binary presence alone. Use the canonical serve command for authenticated CLI fallback.'],
      };
    }
    return {
      ...caps, readOnly: false, selectedRuntime: 'hybrid',
      actions: { sendMessage: true, stop: true, resume: true, setModel: true, setReasoning: true },
      endpoints: [...caps.endpoints, 'managed CLI PTY fallback'],
      notes: [...caps.notes, 'Desktop writes are authorized; CLI PTY is retained as recovery.'],
    };
  }

  private async projectPath(id: string): Promise<string> {
    const thread = await this.desktop.getThread(id);
    const projects = await this.desktop.listProjects();
    const project = projects.find((p) => p.id === thread.projectId || p.path === thread.projectId);
    if (!project?.path) throw new Error('DESKTOP_THREAD_PROJECT_NOT_FOUND');
    return fs.realpath(project.path);
  }

  async sendMessage(id: string, text: string): Promise<Json> {
    const caps = await this.desktop.capabilities();
    if (!caps.readOnly) return this.desktop.sendMessage(id, text);
    if (!this.cliAvailable) throw new Error('FREEBUFF_CLI_NOT_INSTALLED');
    const cwd = await this.projectPath(id);
    const exact = await this.cli.hasConversation(id, cwd);
    const cliId = exact ? id : `desktop-fallback-${createHash('sha256').update(`${cwd}\0${id}`).digest('hex').slice(0, 24)}`;
    const result = exact ? await this.cli.sendMessageInProject(cliId, text, cwd, id) : await this.cli.sendNewMessageInProject(cliId, text, cwd);
    return {
      ...(asRecord(result) ?? {}), routedVia: 'cli_pty', desktopThreadId: id, projectPath: cwd, identityMatch: exact, separateSession: !exact,
      warning: exact ? 'Exact CLI conversation resumed; Desktop was read-only.' : 'Separate CLI session created; the Desktop thread was not mutated.',
    } as Json;
  }

  listProjects() { return this.desktop.listProjects(); }
  listThreads(p?: string) { return this.desktop.listThreads(p); }
  getThread(id: string) { return this.desktop.getThread(id); }
  getMessages(id: string) { return this.desktop.getMessages(id); }
  activeWork(id?: string) { return this.desktop.activeWork(id); }
  getThreadProgress(id: string, a?: number, l?: number) { return this.desktop.getThreadProgress(id, a, l); }
  watchThread(id: string, a?: number, t?: number, l?: number) { return this.desktop.watchThread(id, a, t, l); }
  getThreadProgressSummary(id: string) { return this.desktop.getThreadProgressSummary(id); }
  watchActiveThreads() { return this.desktop.watchActiveThreads(); }
  listFiles(id: string, r?: string) { return this.desktop.listFiles(id, r); }
  readFile(id: string, r: string) { return this.desktop.readFile(id, r); }
  listAttachments(id: string) { return this.desktop.listAttachments(id); }
  listModels() { return this.desktop.listModels(); }
  searchHistory(q: string) { return this.desktop.searchHistory(q); }
  stop(id: string) { return this.desktop.capabilities().then((c) => c.readOnly ? Promise.reject(new Error('DESKTOP_THREAD_WRITE_REQUIRES_EXACT_CLI_SESSION')) : this.desktop.stop(id)); }
  resume(id: string) { return this.desktop.capabilities().then((c) => c.readOnly ? Promise.reject(new Error('DESKTOP_THREAD_WRITE_REQUIRES_EXACT_CLI_SESSION')) : this.desktop.resume(id)); }
  setModel(id: string, m: string, h?: string) { return this.desktop.capabilities().then((c) => c.readOnly ? Promise.reject(new Error('DESKTOP_THREAD_WRITE_REQUIRES_EXACT_CLI_SESSION')) : this.desktop.setModel(id, m, h)); }
  setReasoning(id: string, e: string | null) { return this.desktop.capabilities().then((c) => c.readOnly ? Promise.reject(new Error('DESKTOP_THREAD_WRITE_REQUIRES_EXACT_CLI_SESSION')) : this.desktop.setReasoning(id, e)); }
  dispose() { this.desktop.dispose(); this.cli.dispose(); }
  onProgress(listener: (threadId: string) => void): () => void { return this.desktop.onProgress?.(listener) ?? (() => undefined); }
  createSession(cwd: string): Promise<string> { return this.cli.createSession(cwd); }
}

export async function detectRuntime(): Promise<Runtime> {
  if (process.env.FREEBUFF_MCP_CLI_MODE === 'pty') return new CliPtyRuntime();
  const desktop = new DesktopOrchestratorRuntime();
  if ((await desktop.capabilities()).orchestrator && await findFreebuffCli()) return new HybridRuntime(desktop);
  if ((await desktop.capabilities()).orchestrator) return desktop;
  if (await findFreebuffCli()) return new CliPtyRuntime();
  return new ReadOnlyRuntime();
}

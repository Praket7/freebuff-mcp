import fs from 'node:fs/promises';
import path from 'node:path';
import { assertSafeId, redact, redactString, safeProjectPath, safeTextContent, sanitizeFreebuff } from '../security.js';
import { blocked } from '../security.js';
import { SseClient, SseEvent } from '../desktop/sse.js';
import { mapDesktopEvent, safeMetadata } from '../desktop/event-adapter.js';
import { discoverDesktop, invalidateDiscoveryCache, DesktopCandidate } from '../desktop/discovery.js';
import { BackendCapabilities, BackendEventInput, BackendStreamHealth, BackendTurnResult, BackendSession, BridgeError, BridgeTurnState, ErrorCodes, FreebuffBackend } from '../bridge/types.js';

const REQUEST_TIMEOUT_MS = 8_000;
const RECOVERABLE = /(fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket)/i;
/**
 * How long a verified write-authorization result is trusted. Every write needs
 * it, so without a short cache each send/stop/resume would pay an extra
 * /healthz round-trip on top of its own request.
 */
const HEALTH_TTL_MS = 3_000;
/**
 * How long the FIRST probe waits for the just-started event stream to connect,
 * so a healthy Desktop is not reported as `stale` simply because the stream had
 * not finished connecting when the status call arrived.
 */
const STREAM_SETTLE_MS = 1_500;

/** Maximum number of per-file diffs fetched by a single `get_diff` call. */
export const MAX_DIFF_FILES = 5;

/** How long `sendMessage` waits for a turn to reach a terminal state. */
export const TURN_DEADLINE_MS = 30 * 60_000;
/** How often the fallback poll checks a thread when the event stream is quiet. */
const TURN_POLL_MS = 1_000;
/** How long to wait for a turn to become visible before treating it as instant. */
const TURN_START_GRACE_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Desktop turn state as the orchestrator reports it. */
interface ThreadTurnState {
  turnState: string;
  lastTurnOutcome?: string;
  lastTurnFinishedAt?: number;
}

export interface DesktopBackendOptions {
  /** Explicit base URL (disables broad discovery). */
  baseUrl?: string;
  explicitLaunchId?: string;
  /** Bound for proving a turn started; unproven turns report waiting after it. */
  turnStartGraceMs?: number;
  /** Consecutive SSE failures before outer rediscovery (default 5). */
  streamFailureThreshold?: number;
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
  /** True once the stream has connected at least once in this process. */
  private streamEverConnected = false;
  private healthWritable = false;
  private healthCheckedAt = 0;
  private lastEventAt?: number;
  private eventListeners = new Set<(event: BackendEventInput) => void>();
  private streamListeners = new Set<(health: BackendStreamHealth) => void>();
  /**
   * Set while the stream is down and cleared once a full state snapshot proves
   * the bridge has caught up. Surfaced as `eventGapSuspected` in progress
   * snapshots, which are returned by get_turn/watch_turn/watch_thread.
   */
  private gapSuspected = false;
  private lastUpstreamId?: string;
  /** Latest turn state per thread, kept current from the event stream. */
  private readonly threadStates = new Map<string, ThreadTurnState>();
  private stateWaiters = new Set<() => void>();

  constructor(private options: DesktopBackendOptions = {}) {}

  onBackendEvent(listener: (event: BackendEventInput) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  /**
   * Live SSE connection truth. Adapters (SessionManager -> EventStore) use this
   * so `get_thread_progress_summary`/`watch_turn` cannot report a healthy
   * stream as disconnected, or vice versa. The current value is delivered
   * immediately on subscribe.
   */
  onStreamHealth(listener: (health: BackendStreamHealth) => void): () => void {
    this.streamListeners.add(listener);
    listener(this.streamHealth());
    return () => { this.streamListeners.delete(listener); };
  }

  private streamHealth(): BackendStreamHealth {
    return { connected: this.sseConnected, ...(this.gapSuspected ? { gapSuspected: true } : {}) };
  }

  private notifyStreamHealth(): void {
    const health = this.streamHealth();
    for (const listener of this.streamListeners) listener(health);
  }

  /** Single writer for `sseConnected`, so every transition is observable. */
  private setSseConnected(value: boolean): void {
    if (this.sseConnected === value) return;
    // Losing an established stream means events may have been missed until a
    // fresh full snapshot arrives; claiming otherwise would be a silent lie.
    if (this.sseConnected && !value) this.gapSuspected = true;
    if (value) this.streamEverConnected = true;
    this.sseConnected = value;
    this.notifyStreamHealth();
  }

  /**
   * Fresh write-authorization check. A status query must never be answered from
   * cache — its whole purpose is to report current truth.
   */
  private async checkWritable(): Promise<boolean> {
    let result = false;
    if (this.connection?.launchId) {
      try { const health = await this.request<{ ok?: unknown }>('GET', '/healthz'); result = health?.ok === true; } catch { result = false; }
    }
    this.healthWritable = result;
    this.healthCheckedAt = Date.now();
    return result;
  }

  /**
   * Write-path guard. Reuses a very recent authorization result so one operation
   * does not pay two round-trips; the write request itself remains the
   * authority, and a rotated launch id is recovered by the request layer.
   */
  private async assertWritableCached(): Promise<boolean> {
    if (Date.now() - this.healthCheckedAt < HEALTH_TTL_MS) return this.healthWritable;
    return this.checkWritable();
  }

  /** Full state is known again, so any suspected gap is resolved. */
  private clearSuspectedGap(): void {
    if (!this.gapSuspected) return;
    this.gapSuspected = false;
    this.notifyStreamHealth();
  }

  private async connect(force = false): Promise<void> {
    if (this.connection && !force) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      // A new connection invalidates any cached authorization result.
      this.healthCheckedAt = 0;
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

  /**
   * Idempotent requests are safe to replay after an ambiguous failure; every
   * other POST defaults to NO automatic replay. Replaying a mutation after a
   * dropped socket, a timeout, or a 5xx can execute the same prompt, thread
   * creation, or setting twice — so the allowlist is explicit and narrow:
   * reads plus the control routes whose repeat has no additional effect.
   */
  private static readonly IDEMPOTENT_POST_SUFFIXES = ['/stop', '/resume', '/agent', '/effort'];

  private isIdempotentRequest(method: string, pathname: string): boolean {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    if (method !== 'POST') return false;
    return DesktopBackend.IDEMPOTENT_POST_SUFFIXES.some((suffix) => pathname === suffix || pathname.endsWith(suffix));
  }

  private ambiguousMutationError(method: string, pathname: string, detail: string): BridgeError {
    return new BridgeError(
      ErrorCodes.BACKEND_UNAVAILABLE,
      `Freebuff Desktop ${method} ${pathname} failed ambiguously (${detail}): it is unknown whether the mutation executed, so it was NOT retried.`,
      'Reconcile with list_threads/get_thread first — retrying blindly could submit the same prompt or create the same thread twice.',
    );
  }

  private async request<T>(method: string, pathname: string, body?: unknown, allowReconnect = true): Promise<T> {
    await this.connect();
    if (!this.connection) throw new BridgeError(ErrorCodes.DESKTOP_NOT_FOUND, 'Freebuff Desktop is not connected.');
    const idempotent = this.isIdempotentRequest(method, pathname);
    try {
      const response = await fetch(new URL(pathname, this.connection.base), { method, headers: this.headers(), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        // 401/403/404 are rejections, not ambiguity: the Desktop answered, so
        // re-authenticating (or rediscovering) and retrying once is safe.
        const rejected = [401, 403, 404].includes(response.status);
        if (rejected && allowReconnect) {
          // Authorization rotation or Desktop restart: rediscover and retry once.
          this.connection = undefined;
          this.setSseConnected(false);
          await this.connect(true);
          return await this.request<T>(method, pathname, body, false);
        }
        // A 5xx after a non-idempotent mutation may mean "executed, then
        // failed to answer": never replay it.
        if (response.status >= 500 && !idempotent) throw this.ambiguousMutationError(method, pathname, `HTTP ${response.status}`);
        if (response.status >= 500 && allowReconnect) {
          this.connection = undefined;
          this.setSseConnected(false);
          await this.connect(true);
          return await this.request<T>(method, pathname, body, false);
        }
        // Surface the Desktop's own explanation (for example "no project" or
        // "invalid model") instead of reducing every failure to a status code.
        let detail: string | undefined;
        try {
          const failure = await response.json() as { error?: unknown; message?: unknown };
          const raw = typeof failure?.error === 'string' ? failure.error : typeof failure?.message === 'string' ? failure.message : undefined;
          if (raw) detail = redactString(raw).slice(0, 300);
        } catch { /* the Desktop may return an empty or non-JSON body */ }
        throw new BridgeError(response.status === 401 || response.status === 403 ? ErrorCodes.DESKTOP_AUTH_REQUIRED : ErrorCodes.BACKEND_UNAVAILABLE, `Freebuff Desktop returned HTTP ${response.status} for ${pathname}.${detail ? ` ${detail}` : ''}`, response.status === 401 || response.status === 403 ? 'Restart Freebuff Desktop or reopen the project so it can issue a fresh launch authorization, then retry.' : undefined);
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      // A dropped socket/timeout after a non-idempotent mutation is the
      // textbook ambiguous case ("the server committed, the socket dropped"):
      // reconnecting and replaying could submit the prompt twice. Report
      // unknown instead.
      if (RECOVERABLE.test(String(error)) && !idempotent) throw this.ambiguousMutationError(method, pathname, String(error).slice(0, 120));
      if (RECOVERABLE.test(String(error)) && allowReconnect) {
        this.connection = undefined;
        this.setSseConnected(false);
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
      onConnectionChange: (connected) => { this.setSseConnected(connected); if (connected) this.lastEventAt = Date.now(); },
      onEvent: (event: SseEvent) => {
        this.lastEventAt = Date.now();
        if (event.id) this.lastUpstreamId = event.id;
        this.dispatch(event);
      },
      // A stream that keeps failing against one URL is not a transient blip —
      // the Desktop likely restarted on a new port. Rediscover (bounded) so a
      // rotation alone recovers the stream instead of retrying forever.
      onPersistentFailure: () => this.rediscoverStream(),
      maxConsecutiveFailures: this.options.streamFailureThreshold ?? 5,
    });
    this.sse = client;
    client.start();
  }

  /** Guard so concurrent stream failures trigger at most one rediscovery. */
  private rediscoverPending = false;

  private rediscoverStream(): void {
    if (this.rediscoverPending) return;
    this.rediscoverPending = true;
    void (async () => {
      try {
        if (this.options.baseUrl) { this.startEventStream(); return; }
        invalidateDiscoveryCache();
        const found = await discoverDesktop({ force: true });
        if (found.candidate) {
          this.connection = { base: new URL(found.candidate.url), ...(found.candidate.launchId ? { launchId: found.candidate.launchId } : {}), ...(found.candidate.pid ? { pid: found.candidate.pid } : {}), source: found.candidate.source };
          this.healthCheckedAt = 0;
        }
        this.startEventStream();
      } catch { /* the stream's own retry loop continues */ } finally { this.rediscoverPending = false; }
    })();
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
        // Track authoritative turn state so a turn can be awaited to completion.
        this.recordThreadState(threadId, thread);
        const type = turnState === 'running' ? 'phase' : turnState === 'completed' ? 'completed' : turnState === 'failed' ? 'failed' : turnState === 'cancelled' ? 'cancelled' : 'phase';
        this.emit({ threadId, type, ...(turnState ? { state: turnState } : {}) });
      }
      // A snapshot carries the whole picture, so the bridge is no longer out of sync.
      this.clearSuspectedGap();
      return;
    }
    const mapped = mapDesktopEvent(payload, event.event);
    if (!mapped) return;
    this.emit({ threadId: mapped.threadId, type: mapped.type, ...(mapped.phase ? { phase: mapped.phase } : {}), ...(mapped.state ? { state: mapped.state } : {}), ...(mapped.message !== undefined ? { message: mapped.message } : {}), ...(mapped.tool ? { tool: mapped.tool } : {}), ...(mapped.command ? { command: mapped.command } : {}), ...(mapped.files ? { files: mapped.files } : {}), ...(mapped.error ? { error: mapped.error } : {}) });
  }

  private emit(event: BackendEventInput): void {
    for (const listener of this.eventListeners) listener(event);
  }

  /** Maximum tracked threads; long-lived processes must not accumulate them. */
  private static readonly MAX_TRACKED_THREADS = 500;

  private recordThreadState(threadId: string, source: Record<string, unknown>): void {
    const turnState = typeof source.turnState === 'string' ? source.turnState : undefined;
    if (!turnState) return;
    const previous = this.threadStates.get(threadId);
    this.threadStates.set(threadId, {
      turnState,
      ...(typeof source.lastTurnOutcome === 'string' ? { lastTurnOutcome: source.lastTurnOutcome } : previous?.lastTurnOutcome ? { lastTurnOutcome: previous.lastTurnOutcome } : {}),
      ...(typeof source.lastTurnFinishedAt === 'number' ? { lastTurnFinishedAt: source.lastTurnFinishedAt } : previous?.lastTurnFinishedAt !== undefined ? { lastTurnFinishedAt: previous.lastTurnFinishedAt } : {}),
    });
    while (this.threadStates.size > DesktopBackend.MAX_TRACKED_THREADS) {
      const oldest = this.threadStates.keys().next();
      if (oldest.done) break;
      this.threadStates.delete(oldest.value);
    }
    if (previous?.turnState !== turnState) for (const wake of this.stateWaiters) wake();
  }

  /**
   * Read the latest known turn state. Cached SSE state is only a shortcut when
   * the stream is healthy; while the stream is down (or completion is still
   * unproven) polling must do a fresh HTTP read, otherwise it can inspect the
   * same stale snapshot forever and "prove" completion from it.
   */
  private async readThreadState(threadId: string, options: { fresh?: boolean } = {}): Promise<ThreadTurnState> {
    const cached = this.threadStates.get(threadId);
    if (cached && !options.fresh) return cached;
    try {
      const thread = asRecord(await this.request<unknown>('GET', `/api/thread/${encodeURIComponent(threadId)}`));
      const inner = asRecord(thread?.thread) ?? thread ?? {};
      const fresh: ThreadTurnState = {
        turnState: typeof inner.turnState === 'string' ? inner.turnState : 'idle',
        ...(typeof inner.lastTurnOutcome === 'string' ? { lastTurnOutcome: inner.lastTurnOutcome } : {}),
        ...(typeof inner.lastTurnFinishedAt === 'number' ? { lastTurnFinishedAt: inner.lastTurnFinishedAt } : {}),
      };
      if (typeof inner.turnState === 'string') this.recordThreadState(threadId, inner);
      return fresh;
    } catch {
      if (cached) return cached;
      throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, `Freebuff Desktop could not read thread ${threadId}.`, 'Verify the thread id, or check that Freebuff Desktop is still running.');
    }
  }

  /**
   * Wait until the thread's turn reaches a terminal state.
   *
   * Completion requires PROOF: a `lastTurnFinishedAt` advance, or an observed
   * `running → non-running` transition. A cached `idle` that was never seen
   * running (a discarded prompt, a stale snapshot) proves nothing — after the
   * start grace it returns `undefined` so the caller reports waiting instead
   * of inventing completion.
   *
   * Polling reads fresh HTTP state while completion is unproven (the SSE cache
   * may be the same stale frame forever during an outage).
   */
  private async waitForTurnEnd(threadId: string, before: ThreadTurnState, signal?: AbortSignal): Promise<ThreadTurnState | undefined> {
    const deadline = Date.now() + TURN_DEADLINE_MS;
    // If the turn never visibly starts (an instant turn, or a prompt the Desktop
    // discarded), don't hold the request open for the full deadline — but do
    // NOT treat the unproven idle state as completion either.
    const startDeadline = Math.min(deadline, Date.now() + (this.options.turnStartGraceMs ?? TURN_START_GRACE_MS));
    let sawRunning = false;
    for (;;) {
      if (signal?.aborted) return this.threadStates.get(threadId);
      let current: ThreadTurnState;
      try { current = await this.readThreadState(threadId, { fresh: true }); } catch { current = this.threadStates.get(threadId) ?? { turnState: 'running' }; }
      const finished = current.lastTurnFinishedAt !== undefined && (before.lastTurnFinishedAt ?? 0) < current.lastTurnFinishedAt;
      if (current.turnState === 'running') sawRunning = true;
      if (finished || (sawRunning && current.turnState !== 'running')) return current;
      if ((!sawRunning && Date.now() >= startDeadline) || Date.now() >= deadline) return undefined;
      // No unref(): this timer IS the completion wait. An unref'd timeout may
      // never fire on a quiet event loop, ending the wait early.
      await new Promise<void>((resolve) => {
        let settled = false;
        const wake = () => {
          if (!settled) {
            settled = true;
            this.stateWaiters.delete(wake);
            clearTimeout(timer);
            signal?.removeEventListener('abort', wake);
            resolve();
          }
        };
        const timer = setTimeout(wake, TURN_POLL_MS);
        this.stateWaiters.add(wake);
        if (signal?.aborted) wake();
        else signal?.addEventListener('abort', wake, { once: true });
      });
    }
  }

  private mapTurnOutcome(state: ThreadTurnState | undefined, aborted: boolean): { state: BridgeTurnState; error?: string } {
    if (aborted) return { state: 'cancelled' };
    if (!state) return { state: 'waiting_for_user', error: 'The Desktop did not confirm the turn outcome: no turn start and no finish timestamp were observed.' };
    if (state.lastTurnOutcome === 'error') return { state: 'failed', error: 'The Freebuff turn reported an error outcome.' };
    if (state.turnState === 'running') return { state: 'waiting_for_user', error: 'The turn was still running when the wait ended.' };
    return { state: 'completed' };
  }

  async probe(): Promise<BackendCapabilities> {
    try {
      await this.connect();
    } catch (error) {
      const notFound = error instanceof BridgeError && error.code === ErrorCodes.DESKTOP_NOT_FOUND;
      return { backend: 'desktop', connection: notFound ? 'not_running' : 'unavailable', authorization: 'none', liveProgress: 'unavailable', canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: [error instanceof Error ? error.message : 'Desktop unavailable'] };
    }
    if (!this.connection) return { backend: 'desktop', connection: 'unavailable', authorization: 'none', liveProgress: 'unavailable', canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: ['Desktop not connected.'] };
    const writable = await this.checkWritable();
    if (!this.connection) return { backend: 'desktop', connection: 'not_running', authorization: 'none', liveProgress: 'unavailable', canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: ['Desktop connection was lost during the health check.'] };
    // First call only: give the just-started stream a bounded moment to
    // connect, so a healthy Desktop is not misreported as `stale`.
    if (this.sse !== undefined && !this.sseConnected && !this.streamEverConnected) {
      const settle = Date.now() + STREAM_SETTLE_MS;
      while (!this.sseConnected && Date.now() < settle) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      }
    }
    const started = this.sse !== undefined;
    return {
      backend: 'desktop',
      connection: writable ? 'connected_writable' : 'connected_read_only',
      authorization: writable ? 'write_authorized' : this.connection.launchId ? 'read_only' : 'none',
      // `liveProgress` must never claim progress that isn't arriving, but it
      // must not slander a healthy idle Desktop either. The Desktop event
      // stream has NO heartbeat: it sends a burst of snapshot frames on
      // connect and then stays silent while the project is idle (measured
      // against the live Desktop: 14 frames at connect, then nothing for 45s).
      // Freshness of `lastEventAt` is therefore NOT evidence of health and must
      // not gate this field. The SseClient's own connection state is the honest
      // signal: 'stale' means the stream was started but is currently
      // disconnected and retrying.
      liveProgress: this.sseConnected ? 'connected' : started ? 'stale' : 'unavailable',
      ...(this.lastEventAt !== undefined ? { lastEventAt: new Date(this.lastEventAt).toISOString() } : {}),
      // Creating a thread is a write: read-only means it is not available.
      canCreateSession: writable,
      canSendMessage: writable,
      canStop: writable,
      canResume: writable,
      canSetModel: writable,
      canSetReasoning: writable,
      notes: [`Desktop connected at ${this.connection.base.origin}${this.connection.pid ? ` (PID ${this.connection.pid})` : ''} via ${this.connection.source ?? 'discovery'}.`, writable ? 'Write authorization verified through the launch-ID health check.' : 'Read-only: launch authorization is missing or the health check failed.', this.sseConnected ? 'Live event stream connected.' : 'Live event stream is connecting or unavailable.'],
    };
  }

  private async assertWritable(): Promise<void> {
    // Connect first: the launch id only exists once a Desktop is resolved.
    await this.connect();
    if (!this.connection?.launchId || !(await this.assertWritableCached())) throw new BridgeError(ErrorCodes.DESKTOP_AUTH_REQUIRED, 'Freebuff Desktop write authorization is unavailable.', 'Restart Freebuff Desktop or reopen the project, then retry.');
  }

  async listProjects(): Promise<unknown> {
    const value = await this.request<unknown>('GET', '/api/projects');
    return redact(value);
  }

  /**
   * Create a real Desktop thread. The installed Desktop exposes no dedicated
   * "new conversation" route: `POST /api/threads` is the route the Desktop UI
   * itself uses, and it returns the created thread object (including its id).
   * A brand-new thread is a draft with no messages until the first prompt.
   */
  async createSession({ cwd, continueBackendId }: { cwd: string; continueBackendId?: string }): Promise<BackendSession> {
    await this.assertWritable();
    if (continueBackendId) {
      // Continue an existing thread only after confirming it really exists.
      const thread = asRecord(await this.getThread(continueBackendId));
      const existingId = asString(thread?.id);
      if (!existingId) throw new BridgeError(ErrorCodes.DESKTOP_API_INCOMPATIBLE, `Freebuff Desktop could not read thread ${continueBackendId}.`, 'Verify the thread id, or open the project in Freebuff Desktop first.');
      // The backend owns the session by the thread id, so that is its handle.
      return { id: existingId, backend: 'desktop', backendSessionId: existingId, cwd };
    }
    const created = asRecord(await this.request<unknown>('POST', '/api/threads', { projectPath: cwd }));
    const id = asString(created?.id) ?? asString(asRecord(created?.thread)?.id);
    if (!id) throw new BridgeError(ErrorCodes.DESKTOP_API_INCOMPATIBLE, 'Freebuff Desktop did not return an id for the new thread.', 'Update Freebuff Desktop, or pass an existing threadId to run_turn.');
    return { id, backend: 'desktop', backendSessionId: id, cwd };
  }

  /**
   * `/api/projects` returns PROJECTS with a nested `threads` array; flatten it
   * so callers see threads (each carrying its `projectId`/`projectPath`).
   */
  async listThreads(): Promise<unknown> {
    const projects = await this.request<Record<string, unknown>>('GET', '/api/projects');
    const list = Array.isArray(projects.projects) ? projects.projects : [];
    const threads: Array<Record<string, unknown>> = [];
    for (const value of list) {
      const project = asRecord(value);
      if (!project) continue;
      const projectPath = asString(project.path) ?? asString(project.projectId);
      const nested = Array.isArray(project.threads) ? project.threads : [];
      for (const entry of nested) {
        const thread = asRecord(entry);
        if (!thread) continue;
        threads.push({
          ...thread,
          ...(asString(thread.projectId) ?? projectPath ? { projectId: asString(thread.projectId) ?? projectPath } : {}),
          ...(asString(thread.projectPath) ?? projectPath ? { projectPath: asString(thread.projectPath) ?? projectPath } : {}),
        });
      }
    }
    return sanitizeFreebuff(threads);
  }

  /**
   * `/api/thread/:id` returns `{ thread, messages, items }`. Flatten it so
   * consumers see the thread fields plus `messages`/`items` at the top level
   * (the bridge never forwards the raw wrapper).
   */
  async getThread(backendSessionId: string): Promise<unknown> {
    const value = await this.request<unknown>('GET', `/api/thread/${encodeURIComponent(assertSafeId(backendSessionId))}`);
    const record = asRecord(value);
    const thread = asRecord(record?.thread) ?? record;
    if (!thread) throw new BridgeError(ErrorCodes.DESKTOP_API_INCOMPATIBLE, 'Freebuff Desktop returned an unreadable thread payload.', 'Update Freebuff Desktop, then retry.');
    const messages = record && Array.isArray(record.messages) ? record.messages : Array.isArray(thread.messages) ? thread.messages : undefined;
    return sanitizeFreebuff({
      ...thread,
      ...(messages ? { messages } : {}),
      ...(record && Array.isArray(record.items) ? { items: record.items } : {}),
    });
  }

  async getMessages(backendSessionId: string): Promise<unknown> {
    const thread = asRecord(await this.getThread(backendSessionId));
    const messages = thread && Array.isArray(thread.messages) ? thread.messages : [];
    return sanitizeFreebuff(messages);
  }

  /**
   * Submit a prompt and WAIT for the turn to reach a terminal state.
   *
   * The Desktop's POST /message only acknowledges submission, so returning at
   * that point would report every turn as `completed` before any work happened.
   * We keep the subscription open for the whole turn and await the terminal
   * state reported by the event stream.
   */
  async sendMessage({ session, text, signal, onEvent }: { session: BackendSession; text: string; signal?: AbortSignal; onEvent?: (event: BackendEventInput) => void | Promise<void> }): Promise<BackendTurnResult> {
    if (!text || text.length > 100_000) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Message must be 1 to 100000 characters.');
    await this.assertWritable();
    const threadId = session.backendSessionId ? assertSafeId(session.backendSessionId) : session.id;
    const unsubscribe = onEvent ? this.onBackendEvent((event) => { if (event.threadId === threadId) void onEvent(event); }) : undefined;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      // The `before` snapshot anchors the finish-timestamp comparison, so it
      // must be a fresh read: a stale cache could predate the turn and make a
      // no-op look like a finished turn.
      const before = await this.readThreadState(threadId, { fresh: true }).catch((): ThreadTurnState => ({ turnState: 'idle' }));
      const response = await this.request<unknown>('POST', `/api/thread/${encodeURIComponent(threadId)}/message`, { text });
      // The Desktop acknowledges a submission with `{ ok, queued }` and returns
      // no turn id, so `backendTurnId` stays unset here: the bridge never
      // invents a backend identity it was not given.
      const submitted = { threadId, type: 'phase' as const, state: 'submitted' };
      this.emit(submitted);
      if (onEvent) void onEvent(submitted);
      const end = await this.waitForTurnEnd(threadId, before, controller.signal);
      const mapped = this.mapTurnOutcome(end, controller.signal.aborted);
      const result: BackendTurnResult = { state: mapped.state, result: redact(response) };
      if (mapped.error) result.error = mapped.error;
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
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

  /**
   * Attachments are collected from the thread's own messages. The Desktop's
   * `/attachment` route requires a `path` query parameter and returns ONE file,
   * so it cannot serve a listing.
   */
  async listAttachments(backendSessionId: string): Promise<unknown> {
    const thread = asRecord(await this.getThread(backendSessionId));
    const messages = thread && Array.isArray(thread.messages) ? thread.messages : [];
    const attachments: unknown[] = [];
    for (const message of messages) {
      const record = asRecord(message);
      const list = record && Array.isArray(record.attachments) ? record.attachments : [];
      for (const attachment of list) attachments.push(attachment);
    }
    return sanitizeFreebuff(attachments);
  }

  /** Change summary for a thread (`/api/thread/:id/changes`). */
  async getChanges(backendSessionId: string, scope: 'all' | 'uncommitted' = 'all'): Promise<unknown> {
    const query = new URLSearchParams({ scope });
    return sanitizeFreebuff(await this.request('GET', `/api/thread/${encodeURIComponent(assertSafeId(backendSessionId))}/changes?${query.toString()}`));
  }

  /**
   * Real per-file diff for a thread (`/api/thread/:id/changes/diff`). The
   * Desktop requires a `file` path; an empty path is rejected with
   * `{ error: "invalid path" }`.
   */
  async getDiff(backendSessionId: string, file: string, scope: 'all' | 'uncommitted' = 'all', untracked = false): Promise<unknown> {
    if (!file) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'A file path is required to read a diff.', 'Call get_changes first to list changed files, then request one of them.');
    const query = new URLSearchParams({ file, scope, ...(untracked ? { untracked: 'true' } : {}) });
    return sanitizeFreebuff(await this.request('GET', `/api/thread/${encodeURIComponent(assertSafeId(backendSessionId))}/changes/diff?${query.toString()}`));
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
    this.connection = undefined;
    // Shutting down is not a gap, and nobody needs the notification.
    this.streamListeners.clear();
    this.gapSuspected = false;
    this.sseConnected = false;
    this.streamEverConnected = false;
    this.healthCheckedAt = 0;
    this.healthWritable = false;
  }
}

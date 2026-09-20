import { randomUUID } from 'node:crypto';
import { BridgeError, ErrorCodes, BackendEventInput, BackendSession, BackendTurnResult, BridgeSession, BridgeTurn, BridgeTurnState, FreebuffBackend, isTerminalTurnState } from './types.js';
import { EventStore } from './event-store.js';

export type { BackendEventInput };

export interface StartTurnOptions {
  text: string;
  signal?: AbortSignal;
  /** Verified real Freebuff conversation id to continue, if any. */
  continueBackendId?: string;
}

export interface TurnHandle {
  turn: BridgeTurn;
  session: BridgeSession;
  /** Resolves only when the turn reaches a terminal state. */
  done: Promise<BridgeTurn>;
  events: EventStore;
}

export interface CancelTurnResult {
  /** A live turn was found and its local wait was aborted. */
  aborted: boolean;
  /**
   * The backend owner was asked to stop the turn and acknowledged. False when
   * the backend exposes no stop operation (so only the local wait ended) or
   * when the stop request failed — cancellation is never claimed silently.
   */
  stopped: boolean;
  /** Why the backend stop failed, when it did: the work may still be running. */
  stopError?: string;
}

interface StopOutcome { stopped: boolean; error?: string }

/**
 * Canonical bridge session manager. Protocol adapters depend on this class,
 * never on Desktop/PTY details. Guarantees:
 * - bridge ids are distinct from backend ids;
 * - every turn maps to exactly one active session turn at a time;
 * - terminal turn states clear session running state;
 * - events land in the shared bounded EventStore with the right turn/session.
 */
export class SessionManager {
  readonly events = new EventStore();
  private sessions = new Map<string, BridgeSession>();
  private turns = new Map<string, BridgeTurn>();

  private streamHealthUnsubscribe?: () => void;
  /** True when the backend exposes no persistent stream (CLI/PTY). */
  private readonly turnScopedLiveness: boolean;

  constructor(private backend: FreebuffBackend) {
    // The event store's `connected` flag drives `stale` in every progress
    // snapshot, so it must reflect real stream health. Without this, adapters
    // that use the canonical layer (MCP v2, HTTP, ACP) reported
    // `connected: false, stale: true` even while progress events were actively
    // flowing, because only the legacy runtime ever set it.
    this.turnScopedLiveness = typeof this.backend.onStreamHealth !== 'function';
    this.streamHealthUnsubscribe = this.backend.onStreamHealth?.((health) => {
      this.events.setConnected(health.connected);
      // Keep the gap signal honest: it is returned to clients inside progress
      // snapshots, so it must not stay permanently false.
      this.events.setGapSuspected(Boolean(health.gapSuspected));
    });
  }

  get backendKind(): FreebuffBackend['kind'] { return this.backend.kind; }

  listSessions(): BridgeSession[] { return [...this.sessions.values()]; }

  getSession(id: string): BridgeSession | undefined { return this.sessions.get(id); }

  getTurn(turnId: string): BridgeTurn | undefined { return this.turns.get(turnId); }

  async createSession(options: { cwd: string; continueBackendId?: string; /** pre-verified backend session id */ backendSessionId?: string }): Promise<BridgeSession> {
    const backendSession = await this.ensureBackendSession(options);
    return this.wrapBackendSession(backendSession, options.cwd);
  }

  /**
   * Register a session that already exists (for example, wrapping a known
   * Desktop thread or CLI conversation id). The owner is resolved through the
   * backend facade so `backend`/`backendHandleId` record truth, never the
   * facade's default kind.
   */
  async registerExisting(options: { backendSessionId: string; cwd: string }): Promise<BridgeSession> {
    const backendSession = await this.resolveExistingIdentity(options);
    return this.wrapBackendSession(backendSession, options.cwd);
  }

  /** Rebuild the backend-facing session exactly as the owner shipped it. */
  toBackendSession(session: BridgeSession): BackendSession {
    return {
      id: session.backendHandleId ?? session.id,
      backend: session.backend,
      ...(session.backendSessionId ? { backendSessionId: session.backendSessionId } : {}),
      cwd: session.projectRoot,
    };
  }

  private wrapBackendSession(backendSession: BackendSession, projectRoot: string): BridgeSession {
    const now = new Date().toISOString();
    const session: BridgeSession = {
      id: randomUUID(),
      // The kind that actually owns the session (Desktop or CLI), never the
      // facade default.
      backend: backendSession.backend,
      backendSessionId: backendSession.backendSessionId,
      backendHandleId: backendSession.id,
      projectRoot,
      createdAt: now,
      updatedAt: now,
      state: 'ready',
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private async resolveExistingIdentity(options: { backendSessionId: string; cwd: string }): Promise<BackendSession> {
    // A CompositeBackend can distinguish a CLI conversation id from a Desktop
    // thread id; every other backend owns the id it is handed.
    const resolver = this.backend as unknown as { resolveExisting?(backendSessionId: string, cwd: string): Promise<BackendSession> | BackendSession };
    if (resolver.resolveExisting) return await resolver.resolveExisting(options.backendSessionId, options.cwd);
    return { id: options.backendSessionId, backend: this.backend.kind, backendSessionId: options.backendSessionId, cwd: options.cwd };
  }

  private async ensureBackendSession(options: { cwd: string; continueBackendId?: string; backendSessionId?: string }): Promise<BackendSession> {
    if (!this.backend.createSession) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, `The ${this.backend.kind} backend cannot create sessions.`, 'Use an existing Freebuff thread or conversation id instead.');
    return await this.backend.createSession({ cwd: options.cwd, ...(options.continueBackendId || options.backendSessionId ? { continueBackendId: options.continueBackendId ?? options.backendSessionId } : {}) });
  }

  /** Start a canonical turn. `done` resolves only at a terminal state. */
  startTurn(sessionId: string, options: StartTurnOptions): TurnHandle {
    const session = this.sessions.get(sessionId);
    if (!session) throw new BridgeError(ErrorCodes.SESSION_NOT_FOUND, `Unknown bridge session ${sessionId}.`, 'Create a session first or list existing sessions.');
    if (session.activeTurnId && this.turns.get(session.activeTurnId) && !isTerminalTurnState(this.turns.get(session.activeTurnId)!.state)) {
      throw new BridgeError(ErrorCodes.TURN_ALREADY_ACTIVE, `Session ${sessionId} already has an active turn.`, 'Stop or wait for the active turn, then retry.');
    }
    const now = new Date().toISOString();
    const turn: BridgeTurn = { id: randomUUID(), sessionId, state: 'queued', createdAt: now, lastSequence: 0 };
    this.turns.set(turn.id, turn);
    session.activeTurnId = turn.id;
    session.updatedAt = now;
    this.events.append({ sessionId, turnId: turn.id, threadId: session.backendSessionId ?? session.id, type: 'queued' });

    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    // The turn's own controller is always available for cancelTurn.
    this.controllers.set(turn.id, controller);

    const setState = (state: BridgeTurnState, extra?: Partial<BridgeTurn>) => {
      turn.state = state;
      if (extra?.result !== undefined) turn.result = extra.result;
      if (extra?.error !== undefined) turn.error = extra.error;
      if (extra?.backendTurnId) turn.backendTurnId = extra.backendTurnId;
      turn.lastSequence = this.events.lastSequenceFor({ turnId: turn.id });
      session.updatedAt = new Date().toISOString();
      // A session whose owner has no persistent stream (CLI/PTY) is only
      // "live" while one of its turns is running. This is per-backend-owner,
      // not per facade: a composite that also fronts a streaming Desktop must
      // still report turn-scoped liveness for its CLI-owned threads. It is
      // attributed per thread — another session's turn (or silence) must never
      // refresh this one.
      if (this.turnScopedLiveness || session.backend === 'cli') this.events.setThreadLive(session.backendSessionId ?? session.id, !isTerminalTurnState(state));
      if (state === 'running') session.state = 'running';
      else if (state === 'waiting_for_user') session.state = 'waiting_for_user';
      else if (isTerminalTurnState(state)) {
        if (session.activeTurnId === turn.id) session.activeTurnId = undefined;
        session.state = 'ready';
        turn.completedAt = new Date().toISOString();
        this.pruneTerminalTurns();
      }
      if (isTerminalTurnState(state)) {
        this.events.setTurnState(session.backendSessionId ?? session.id, sessionId, turn.id, state, turn.error);
      }
    };

    const done = (async (): Promise<BridgeTurn> => {
      try {
      setState('running');
      this.events.append({ sessionId, turnId: turn.id, threadId: session.backendSessionId ?? session.id, type: 'turn_started', state: 'running' });
      const onEvent = (event: BackendEventInput): void => {
        this.events.append({
          sessionId,
          turnId: turn.id,
          threadId: event.threadId ?? session.backendSessionId ?? session.id,
          type: event.type,
          ...(event.upstreamEventId ? { upstreamEventId: event.upstreamEventId } : {}),
          ...(event.timestamp ? { timestamp: event.timestamp } : {}),
          ...(event.phase ? { phase: event.phase } : {}),
          ...(event.state ? { state: event.state } : {}),
          ...(event.message !== undefined ? { message: event.message } : {}),
          ...(event.tool ? { tool: event.tool } : {}),
          ...(event.command ? { command: event.command } : {}),
          ...(event.files ? { files: event.files } : {}),
          ...(event.error ? { error: event.error } : {}),
          ...(event.metadata ? { metadata: event.metadata } : {}),
        });
        turn.lastSequence = this.events.lastSequenceFor({ turnId: turn.id });
      };
      try {
        const backendSession = this.toBackendSession(session);
        const onAbort = () => {
          // Aborting the local wait is NOT stopping the backend. Ask the owner
          // to stop the turn too, otherwise a "cancelled" Desktop thread or CLI
          // process keeps working with nobody reading its output. The terminal
          // 'cancelled' state is recorded only after the stop settles (below),
          // so cancellation is never reported before the backend was asked.
          if (this.backend.stop && !this.stopOutcomes.has(turn.id)) {
            this.stopOutcomes.set(turn.id, (async (): Promise<StopOutcome> => {
              try { await this.backend.stop!(backendSession, turn.id); return { stopped: true }; }
              catch (error) { return { stopped: false, error: error instanceof Error ? error.message : String(error) }; }
            })());
          }
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const result = await this.backend.sendMessage({ session: backendSession, text: options.text, signal: controller.signal, onEvent });
        controller.signal.removeEventListener('abort', onAbort);
        if (controller.signal.aborted) {
          // The wait was aborted: the turn is over locally, but only mark it
          // terminal once the backend stop outcome is known, and record an
          // unconfirmed stop loudly instead of implying the work stopped.
          let stop = await this.stopOutcomes.get(turn.id)?.catch((): StopOutcome => ({ stopped: false, error: 'stop outcome unavailable' }));
          if (!stop && this.backend.stop) {
            // The abort landed after the listener was removed: the backend was
            // never asked. Ask now rather than silently skipping the stop.
            try { await this.backend.stop(backendSession, turn.id); stop = { stopped: true }; }
            catch (error) { stop = { stopped: false, error: error instanceof Error ? error.message : String(error) }; }
          }
          setState('cancelled', {
            backendTurnId: result.backendTurnId,
            ...(stop && !stop.stopped && this.backend.stop
              ? { error: `Turn cancelled locally, but the backend stop ${stop.error ? `failed (${stop.error})` : 'was not confirmed'} — the underlying work may still be running.` }
              : {}),
          });
        } else if (result.state === 'completed') {
          setState('completed', { result: result.result, backendTurnId: result.backendTurnId });
        } else if (result.state === 'cancelled') {
          setState('cancelled', { backendTurnId: result.backendTurnId });
        } else if (result.state === 'waiting_for_user') {
          setState('waiting_for_user', { backendTurnId: result.backendTurnId });
        } else {
          setState('failed', { error: result.error ?? 'The Freebuff backend reported an unspecified failure.', backendTurnId: result.backendTurnId });
        }
      } catch (error) {
        const aborted = controller.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        if (aborted) {
          let stop = await this.stopOutcomes.get(turn.id)?.catch((): StopOutcome => ({ stopped: false, error: 'stop outcome unavailable' }));
          if (!stop && this.backend.stop) {
            try { await this.backend.stop(this.toBackendSession(session), turn.id); stop = { stopped: true }; }
            catch (stopError) { stop = { stopped: false, error: stopError instanceof Error ? stopError.message : String(stopError) }; }
          }
          setState('cancelled', { error: stop && !stop.stopped && this.backend.stop ? `Turn cancelled locally, but the backend stop ${stop.error ? `failed (${stop.error})` : 'was not confirmed'} — the underlying work may still be running.` : 'Turn cancelled.' });
        } else {
          setState('failed', { error: message });
        }
      }
      return turn;
      } finally {
        this.controllers.delete(turn.id);
        this.stopOutcomes.delete(turn.id);
      }
    })();

    return { turn, session, done, events: this.events };
  }

  /**
   * Abort the active turn, if any, AND ask the owning backend to stop it.
   *
   * Cancellation is only truthful when the backend that owns the work stops
   * doing it; aborting the local wait alone left Desktop threads/CLI processes
   * running. `stopped` reports whether that backend request was acknowledged.
   */
  async cancelTurn(sessionId: string, turnId?: string): Promise<CancelTurnResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { aborted: false, stopped: false };
    const target = turnId ?? session.activeTurnId;
    if (!target) return { aborted: false, stopped: false };
    const controller = this.controllers.get(target);
    if (!controller) return { aborted: false, stopped: false };
    // Aborting synchronously runs the turn's abort listener, which issues the
    // backend stop; capture that promise before awaiting so we report real truth.
    if (!controller.signal.aborted) controller.abort();
    const stopping = this.stopOutcomes.get(target);
    const outcome = stopping ? await stopping.catch((): StopOutcome => ({ stopped: false, error: 'stop outcome unavailable' })) : undefined;
    return { aborted: true, stopped: outcome?.stopped ?? false, ...(outcome?.error ? { stopError: outcome.error } : {}) };
  }

  /** Drop old terminal turns so long-lived processes cannot accumulate them. */
  private pruneTerminalTurns(maxTurns = 500): void {
    if (this.turns.size <= maxTurns) return;
    const terminal = [...this.turns.values()]
      .filter((t) => isTerminalTurnState(t.state))
      .sort((a, b) => Date.parse(a.completedAt ?? a.createdAt) - Date.parse(b.completedAt ?? b.createdAt));
    for (const turn of terminal.slice(0, this.turns.size - maxTurns)) {
      this.turns.delete(turn.id);
    }
  }

  private controllers = new Map<string, AbortController>();
  /** Backend stop requests issued when a turn is aborted, keyed by turn id. */
  private stopOutcomes = new Map<string, Promise<StopOutcome>>();
  /** Register a controller so cancelTurn can abort a running turn. */
  registerController(turnId: string, controller: AbortController): void { this.controllers.set(turnId, controller); }
  unregisterController(turnId: string): void { this.controllers.delete(turnId); }

  dispose(): void {
    this.streamHealthUnsubscribe?.();
    this.streamHealthUnsubscribe = undefined;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    void this.backend.dispose?.();
  }
}

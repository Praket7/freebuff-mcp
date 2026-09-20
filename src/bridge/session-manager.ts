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
  private resolvers = new Map<string, () => void>();

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
    this.streamHealthUnsubscribe = this.backend.onStreamHealth?.((connected) => this.events.setConnected(connected));
  }

  get backendKind(): FreebuffBackend['kind'] { return this.backend.kind; }

  listSessions(): BridgeSession[] { return [...this.sessions.values()]; }

  getSession(id: string): BridgeSession | undefined { return this.sessions.get(id); }

  getTurn(turnId: string): BridgeTurn | undefined { return this.turns.get(turnId); }

  async createSession(options: { cwd: string; continueBackendId?: string; /** pre-verified backend session id */ backendSessionId?: string }): Promise<BridgeSession> {
    const backendSession = await this.ensureBackendSession(options);
    const now = new Date().toISOString();
    const session: BridgeSession = {
      id: randomUUID(),
      backend: this.backend.kind,
      backendSessionId: backendSession.backendSessionId,
      projectRoot: options.cwd,
      createdAt: now,
      updatedAt: now,
      state: 'ready',
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Register a session that already exists (for example, wrapping a known Desktop thread). */
  registerExisting(options: { backendSessionId: string; cwd: string }): BridgeSession {
    const now = new Date().toISOString();
    const session: BridgeSession = {
      id: randomUUID(),
      backend: this.backend.kind,
      backendSessionId: options.backendSessionId,
      projectRoot: options.cwd,
      createdAt: now,
      updatedAt: now,
      state: 'ready',
    };
    this.sessions.set(session.id, session);
    return session;
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
      // A backend with no persistent stream is only "live" while a turn is
      // running, so liveness follows the turn lifecycle there rather than
      // leaving `connected` permanently false.
      if (this.turnScopedLiveness) this.events.setConnected(!isTerminalTurnState(state));
      if (state === 'running') session.state = 'running';
      else if (state === 'waiting_for_user') session.state = 'waiting_for_user';
      else if (isTerminalTurnState(state)) {
        if (session.activeTurnId === turn.id) session.activeTurnId = undefined;
        session.state = 'ready';
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
        const backendSession: BackendSession = { id: session.id, backend: session.backend, ...(session.backendSessionId ? { backendSessionId: session.backendSessionId } : {}), cwd: session.projectRoot };
        const onAbort = () => { if (!isTerminalTurnState(turn.state)) setState('cancelled'); };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const result = await this.backend.sendMessage({ session: backendSession, text: options.text, signal: controller.signal, onEvent });
        controller.signal.removeEventListener('abort', onAbort);
        if (controller.signal.aborted) {
          setState('cancelled', { backendTurnId: result.backendTurnId });
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
        setState(aborted ? 'cancelled' : 'failed', { error: aborted ? 'Turn cancelled.' : message });
      }
      return turn;
      } finally {
        this.controllers.delete(turn.id);
      }
    })();

    return { turn, session, done, events: this.events };
  }

  /** Abort the active turn, if any. Returns whether a turn was aborted. */
  cancelTurn(sessionId: string, turnId?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const target = turnId ?? session.activeTurnId;
    if (!target) return false;
    // The AbortController lives inside startTurn's async scope; expose
    // cancellation by marking state and letting the backend's signal listeners
    // fire via the registered controller. We keep a registry of controllers.
    const controller = this.controllers.get(target);
    if (controller) { controller.abort(); return true; }
    return false;
  }

  private controllers = new Map<string, AbortController>();
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

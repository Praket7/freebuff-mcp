import { BridgeError, ErrorCodes, BridgeTurn, BridgeTurnState, isTerminalTurnState } from './types.js';
import { EventStore, ThreadProgressSnapshot } from './event-store.js';
import { SessionManager, CancelTurnResult } from './session-manager.js';

export interface TurnProgressSnapshot extends ThreadProgressSnapshot {
  turnId: string;
  sessionId: string;
}

/**
 * Canonical turn manager built on the session manager. Protocol adapters use
 * this to start turns, await terminal states, and read request-scoped progress
 * with correct incremental cursors.
 */
export class TurnManager {
  constructor(private manager: SessionManager) {}

  get events(): EventStore { return this.manager.events; }

  async startTurn(sessionId: string, options: { text: string; signal?: AbortSignal; continueBackendId?: string }): Promise<BridgeTurn> {
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const handle = this.manager.startTurn(sessionId, { text: options.text, signal: controller.signal, ...(options.continueBackendId ? { continueBackendId: options.continueBackendId } : {}) });
    this.manager.registerController(handle.turn.id, controller);
    try {
      return await handle.done;
    } finally {
      this.manager.unregisterController(handle.turn.id);
    }
  }

  /** Start a turn without awaiting the terminal state (async fire-and-observe). */
  startTurnDetached(sessionId: string, options: { text: string; continueBackendId?: string }): { turnId: string; done: Promise<BridgeTurn> } {
    const handle = this.manager.startTurn(sessionId, { text: options.text, ...(options.continueBackendId ? { continueBackendId: options.continueBackendId } : {}) });
    return { turnId: handle.turn.id, done: handle.done };
  }

  getTurn(turnId: string): BridgeTurn {
    const turn = this.manager.getTurn(turnId);
    if (!turn) throw new BridgeError(ErrorCodes.TURN_NOT_FOUND, `Unknown bridge turn ${turnId}.`, 'Start a new turn or check the session id.');
    return turn;
  }

  turnState(turnId: string): BridgeTurnState | undefined { return this.manager.getTurn(turnId)?.state; }

  async cancelTurn(sessionId: string, turnId?: string): Promise<CancelTurnResult> { return this.manager.cancelTurn(sessionId, turnId); }

  progressForTurn(turnId: string, afterSequence = 0, limit = 50): TurnProgressSnapshot {
    const turn = this.getTurn(turnId);
    const session = this.manager.getSession(turn.sessionId);
    const snapshot = this.events.progress(session?.backendSessionId ?? turn.sessionId, afterSequence, limit, turn.sessionId, turnId);
    return { ...snapshot, turnId, sessionId: turn.sessionId, ...(snapshot.turnState ? {} : { turnState: turn.state }) } as TurnProgressSnapshot;
  }

  /** Wait until the turn reaches a terminal state (or timeout). */
  async waitForTurn(turnId: string, timeoutMs = 30_000, afterSequence = 0, limit = 50): Promise<TurnProgressSnapshot> {
    const turn = this.getTurn(turnId);
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 120_000);
    let cursor = afterSequence;
    for (;;) {
      const snapshot = this.progressForTurn(turnId, cursor, limit);
      if (snapshot.nextSequence && snapshot.nextSequence > cursor) cursor = snapshot.nextSequence;
      const state = this.manager.getTurn(turnId)?.state;
      if (state && isTerminalTurnState(state)) return snapshot;
      if (state === 'waiting_for_user') return snapshot;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return snapshot;
      const waited = await this.events.wait(snapshot.threadId, cursor, Math.min(remaining, 5_000), limit, turn.sessionId, turnId);
      if (waited.nextSequence && waited.nextSequence > cursor) cursor = waited.nextSequence;
    }
  }
}

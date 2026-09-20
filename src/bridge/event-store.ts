import { BridgeEvent, BridgeEventType, BridgePhase, BridgeTurnState, isTerminalTurnState } from './types.js';

const MAX_EVENTS_PER_THREAD = 500;
const MAX_BYTES_PER_THREAD = 1_000_000;
const TTL_MS = 30 * 60_000;
const STALE_MS = 90_000;

export interface EventQuery {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  afterSequence?: number;
  limit?: number;
}

export interface EventPage {
  events: BridgeEvent[];
  nextSequence: number;
  hasMore: boolean;
}

export interface EventStoreAppendInput {
  sessionId: string;
  turnId: string;
  threadId: string;
  type: BridgeEventType;
  upstreamEventId?: string;
  timestamp?: string;
  phase?: BridgePhase;
  state?: string;
  message?: string;
  tool?: string;
  command?: string;
  files?: string[];
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ThreadProgressSnapshot {
  threadId: string;
  sessionId?: string;
  activeTurnId?: string;
  turnState?: BridgeTurnState;
  phase?: BridgePhase;
  currentState?: string;
  events: BridgeEvent[];
  nextSequence?: number;
  connected: boolean;
  stale: boolean;
  latestEventAt?: string;
  activeTool?: string;
  filesChanged?: string[];
  lastMeaningfulUpdate?: string;
  lastError?: string;
  secondsSinceLastEvent?: number;
  eventGapSuspected?: boolean;
}

interface Entry { event: BridgeEvent; bytes: number }

/**
 * Bounded, incremental, per-thread event store.
 *
 * - Sequences are global and monotonic (a client that reads events 1-100 can
 *   read event 101 with afterSequence=100).
 * - Retention is bounded per thread by count, bytes, and TTL.
 * - Staleness is tracked per thread, never globally.
 */
export class EventStore {
  private threads = new Map<string, Entry[]>();
  private turns = new Map<string, BridgeTurnState>();
  private lastActivity = new Map<string, number>();
  private sequence = 0;
  private waiters = new Map<string, Set<(sequence: number) => void>>();
  private listeners = new Set<(threadId: string) => void>();
  private connected = false;
  private gapSuspected = false;

  subscribe(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setConnected(value: boolean): void {
    this.connected = value;
  }

  setGapSuspected(value: boolean): void {
    this.gapSuspected = value;
  }

  get isConnected(): boolean { return this.connected; }

  append(input: EventStoreAppendInput): BridgeEvent {
    this.sequence += 1;
    const event: BridgeEvent = {
      sequence: this.sequence,
      upstreamEventId: input.upstreamEventId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      threadId: input.threadId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      type: input.type,
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.files ? { files: input.files } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const bytes = JSON.stringify(event).length;
    const key = input.threadId;
    const entries = (this.threads.get(key) ?? []).filter((x) => Date.now() - Date.parse(x.event.timestamp) <= TTL_MS);
    entries.push({ event, bytes });
    let size = entries.reduce((n, x) => n + x.bytes, 0);
    while (entries.length > 1 && (entries.length > MAX_EVENTS_PER_THREAD || size > MAX_BYTES_PER_THREAD)) {
      const removed = entries.shift();
      size -= removed?.bytes ?? 0;
    }
    this.threads.set(key, entries);
    this.lastActivity.set(key, Date.now());
    this.lastActivity.set(`turn:${input.turnId}`, Date.now());
    for (const wake of this.waiters.get(key) ?? []) wake(event.sequence);
    for (const listener of this.listeners) listener(key);
    return event;
  }

  /** Notify turn state transitions; terminal states clear running state. */
  setTurnState(threadId: string, sessionId: string, turnId: string, state: BridgeTurnState, error?: string): void {
    this.turns.set(turnId, state);
    const type: BridgeEventType = state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : state === 'waiting_for_user' ? 'waiting_for_user' : 'turn_started';
    this.append({ sessionId, turnId, threadId, type, state, ...(error ? { error } : {}) });
  }

  turnState(turnId: string): BridgeTurnState | undefined {
    return this.turns.get(turnId);
  }

  read(query: EventQuery = {}): EventPage {
    const after = query.afterSequence ?? 0;
    const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
    const events: BridgeEvent[] = [];
    for (const [threadId, entries] of this.threads) {
      if (query.threadId && threadId !== query.threadId) continue;
      for (const entry of entries) {
        if (query.sessionId && entry.event.sessionId !== query.sessionId) continue;
        if (query.turnId && entry.event.turnId !== query.turnId) continue;
        if (entry.event.sequence <= after) continue;
        events.push(entry.event);
      }
    }
    events.sort((a, b) => a.sequence - b.sequence);
    const page = events.slice(0, limit);
    const nextSequence = page.length ? page[page.length - 1]!.sequence : after;
    return { events: page, nextSequence, hasMore: events.length > page.length };
  }

  lastSequenceFor(query: { sessionId?: string; threadId?: string; turnId?: string }): number {
    let last = 0;
    for (const [threadId, entries] of this.threads) {
      if (query.threadId && threadId !== query.threadId) continue;
      for (const entry of entries) {
        if (query.sessionId && entry.event.sessionId !== query.sessionId) continue;
        if (query.turnId && entry.event.turnId !== query.turnId) continue;
        last = Math.max(last, entry.event.sequence);
      }
    }
    return last;
  }

  progress(threadId: string, afterSequence = 0, limit = 50, sessionId?: string, turnId?: string): ThreadProgressSnapshot {
    const entries = this.threads.get(threadId) ?? [];
    const events = entries.map((x) => x.event).filter((x) => x.sequence > afterSequence && (!sessionId || x.sessionId === sessionId) && (!turnId || x.turnId === turnId)).slice(0, Math.max(1, Math.min(limit, 100)));
    const all = entries.map((x) => x.event);
    const latest = all.at(-1);
    const activeTurn = turnId ?? latest?.turnId;
    const meaningful = [...all].reverse().find((x) => x.phase || ['turn_started', 'tool_started', 'tool_finished', 'completed', 'failed', 'cancelled', 'waiting_for_user'].includes(x.type));
    const activeTool = [...all].reverse().find((x) => x.tool && (x.type === 'tool_started' || x.type === 'tool_finished'))?.tool;
    const filesChanged = [...new Set(all.flatMap((x) => x.files ?? []))].slice(-100);
    const lastError = [...all].reverse().find((x) => x.error)?.error;
    const turnState = activeTurn ? this.turns.get(activeTurn) : undefined;
    return {
      threadId,
      ...(sessionId ? { sessionId } : {}),
      ...(activeTurn ? { activeTurnId: activeTurn } : {}),
      ...(turnState ? { turnState } : {}),
      currentState: turnState ?? [...all].reverse().find((x) => x.state)?.state,
      phase: [...all].reverse().find((x) => x.phase && (x.sequence > afterSequence))?.phase ?? meaningful?.phase,
      events,
      nextSequence: this.lastSequenceFor({ threadId }),
      connected: this.connected,
      stale: !this.connected || (latest ? Date.now() - Date.parse(latest.timestamp) > STALE_MS : entries.length === 0),
      latestEventAt: latest?.timestamp,
      activeTool,
      filesChanged,
      lastMeaningfulUpdate: meaningful?.timestamp,
      ...(lastError ? { lastError } : {}),
      secondsSinceLastEvent: latest ? Math.max(0, Math.floor((Date.now() - Date.parse(latest.timestamp)) / 1000)) : undefined,
      eventGapSuspected: this.gapSuspected,
    };
  }

  /** Thread ids with recent (non-stale by their own clock) activity. */
  activeThreads(): string[] {
    const now = Date.now();
    return [...this.threads.entries()].filter(([threadId, entries]) => {
      const latest = entries.at(-1);
      if (!latest) return false;
      if (now - Date.parse(latest.event.timestamp) > TTL_MS) return false;
      const turn = this.turns.get(latest.event.turnId);
      if (turn && isTerminalTurnState(turn)) return false;
      return true;
    }).map(([threadId]) => threadId);
  }

  /** Resolve with new events for a thread, or timeout. Does not lose wakeups: checks current events first. */
  wait(threadId: string, afterSequence: number, timeoutMs: number, limit = 50, sessionId?: string, turnId?: string): Promise<ThreadProgressSnapshot> {
    return new Promise((resolve) => {
      let settled = false;
      const initial = this.progress(threadId, afterSequence, limit, sessionId, turnId);
      if (initial.events.length) { resolve(initial); return; }
      const set = this.waiters.get(threadId) ?? new Set<(sequence: number) => void>();
      const cleanup = () => { clearTimeout(timer); set.delete(wake); if (!set.size) this.waiters.delete(threadId); };
      const wake = () => {
        if (settled) return;
        const current = this.progress(threadId, afterSequence, limit, sessionId, turnId);
        if (!current.events.length) return;
        settled = true;
        cleanup();
        resolve(current);
      };
      set.add(wake);
      this.waiters.set(threadId, set);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(this.progress(threadId, afterSequence, limit, sessionId, turnId));
      }, Math.max(0, Math.min(timeoutMs, 60_000)));
    });
  }

  /** Last activity timestamp for one thread (or turn) — staleness is never global. */
  lastActivityAt(threadId: string): number | undefined { return this.lastActivity.get(threadId); }
}

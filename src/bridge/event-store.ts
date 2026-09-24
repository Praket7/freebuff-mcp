import { BridgeEvent, BridgeEventType, BridgePhase, BridgeTurnState, isTerminalTurnState } from './types.js';

const MAX_EVENTS_PER_THREAD = 500;
const MAX_BYTES_PER_THREAD = 1_000_000;
const TTL_MS = 30 * 60_000;
const STALE_MS = 90_000;
/** Maximum retained per-thread buckets; one key per historical thread otherwise. */
const MAX_THREADS = 5_000;

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
  private sequence = 0;
  private waiters = new Map<string, Set<(sequence: number) => void>>();
  private listeners = new Set<(threadId: string) => void>();
  private connected = false;
  private gapSuspected = false;
  /**
   * Turn-scoped liveness per thread (sessions whose owner has no persistent
   * stream, e.g. CLI/PTY): a thread is `live` only while one of its turns is
   * running, and the flag must never bleed across threads the way a global
   * flag would. Explicit `false` (a finished CLI turn) overrides even a
   * healthy global stream: the Desktop stream says nothing about a CLI thread.
   */
  private threadLive = new Map<string, boolean>();
  private threadLiveAt = new Map<string, number>();

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

  /** Attribute liveness to a specific thread (turn-scoped), true or false. */
  setThreadLive(threadId: string, value: boolean): void {
    this.threadLive.set(threadId, value);
    this.threadLiveAt.set(threadId, Date.now());
    this.evictStaleLiveness();
  }

  /** Drop liveness markers older than the event TTL so they cannot accumulate. */
  private evictStaleLiveness(now = Date.now()): void {
    if (this.threadLive.size <= 64) return;
    for (const [threadId, at] of this.threadLiveAt) {
      if (now - at > TTL_MS) {
        this.threadLive.delete(threadId);
        this.threadLiveAt.delete(threadId);
      }
    }
  }

  get isConnected(): boolean { return this.connected; }

  append(input: EventStoreAppendInput): BridgeEvent {
    this.sequence += 1;
    // Normalize timestamps on append: an invalid timestamp would poison every
    // staleness calculation downstream with NaN math.
    const timestamp = input.timestamp && !Number.isNaN(Date.parse(input.timestamp)) ? input.timestamp : new Date().toISOString();
    const event: BridgeEvent = {
      sequence: this.sequence,
      upstreamEventId: input.upstreamEventId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      threadId: input.threadId,
      timestamp,
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
    this.pruneThreads();
    for (const wake of this.waiters.get(key) ?? []) wake(event.sequence);
    for (const listener of this.listeners) listener(key);
    return event;
  }

  /**
   * Bound the thread map: drop fully-expired (empty after TTL filtering)
   * buckets first, then the stalest buckets when still over the cap. Buckets
   * with a non-terminal active turn are never evicted.
   */
  /** Amortization counter for thread pruning. */
  private pruneCounter = 0;

  private pruneThreads(now = Date.now()): void {
    // Amortized: steady-state appends skip pruning entirely; expiry sweeps
    // run near the cap and full trims only past cap + slack, at most once
    // every 500 appends while over the cap.
    if (this.threads.size <= MAX_THREADS + 500) {
      if (this.threads.size > MAX_THREADS) this.dropExpiredBuckets(now);
      return;
    }
    this.pruneCounter += 1;
    if (this.pruneCounter % 500 !== 0) return;
    this.dropExpiredBuckets(now);
    if (this.threads.size <= MAX_THREADS) return;
    const byAge = [...this.threads.entries()]
      .filter(([threadId, entries]) => {
        // A thread explicitly marked live (a running CLI/PTY turn)
        // is never evicted, even if its turn state isn't yet
        // terminal in this store.
        if (this.threadLive.get(threadId) === true) return false;
        const turn = this.turns.get(entries.at(-1)?.event.turnId ?? '');
        return !turn || isTerminalTurnState(turn);
      })
      .sort(([, a], [, b]) => Date.parse(a.at(-1)?.event.timestamp ?? '') - Date.parse(b.at(-1)?.event.timestamp ?? ''));
    for (const [threadId] of byAge.slice(0, this.threads.size - MAX_THREADS)) {
      this.threads.delete(threadId);
      this.threadLive.delete(threadId);
      this.threadLiveAt.delete(threadId);
    }
  }

  /** Remove buckets whose every event expired; expiry is TTL-filtered on read. */
  private dropExpiredBuckets(now = Date.now()): void {
    for (const [threadId, entries] of this.threads) {
      const live = entries.filter((x) => now - Date.parse(x.event.timestamp) <= TTL_MS);
      if (!live.length) {
        this.threads.delete(threadId);
        this.threadLive.delete(threadId);
        this.threadLiveAt.delete(threadId);
      } else if (live.length !== entries.length) {
        this.threads.set(threadId, live);
      }
    }
  }

  /** Notify turn state transitions; terminal states clear running state. */
  setTurnState(threadId: string, sessionId: string, turnId: string, state: BridgeTurnState, error?: string): void {
    this.turns.set(turnId, state);
    // Bound turn-state memory for long-lived processes (insertion-ordered, so
    // the oldest — overwhelmingly long-terminal — entries go first).
    // CRITICAL: Never evict a non-terminal turn state (queued/running/waiting_for_user)
    // solely because it is old. Only evict terminal states first. If the store
    // contains more active states than the nominal cap, temporarily exceeding the
    // cap is preferable to losing correctness.
    while (this.turns.size > 2_000) {
      const oldest = this.turns.keys().next();
      if (oldest.done) break;
      const oldestState = this.turns.get(oldest.value);
      if (oldestState && !isTerminalTurnState(oldestState)) {
        // Skip non-terminal states; try the next oldest
        // We need to find a terminal state to evict
        let foundTerminal = false;
        for (const [key, value] of this.turns) {
          if (isTerminalTurnState(value)) {
            this.turns.delete(key);
            foundTerminal = true;
            break;
          }
        }
        if (!foundTerminal) {
          // No terminal states to evict; temporarily exceed cap rather than
          // lose track of an active turn. This is the correct behavior:
          // active turns must never be evicted.
          break;
        }
      } else {
        this.turns.delete(oldest.value);
      }
    }
    const type: BridgeEventType = state === 'queued' ? 'queued' : state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : state === 'waiting_for_user' ? 'waiting_for_user' : 'turn_started';
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
      // A cursor is an acknowledgement of delivered data. Returning the
      // thread's newest sequence here can skip filtered events or events past
      // this page's limit forever.
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      // A thread explicitly marked live (a running CLI/PTY turn) is connected
      // regardless of the global flag; an explicitly finished one is not,
      // even when some other backend's stream is healthy. Every other thread
      // falls back to the backend stream's global state. Never a single
      // global leak across sessions.
      connected: this.threadLive.get(threadId) ?? this.connected,
      stale: !(this.threadLive.get(threadId) ?? this.connected) || (latest ? Date.now() - Date.parse(latest.timestamp) > STALE_MS : entries.length === 0),
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
}

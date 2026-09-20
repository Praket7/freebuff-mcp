import { redact } from '../security.js';
import { Json } from '../types.js';

const MAX_FRAME = 512_000;

export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
  retryMs?: number;
}

/**
 * Parse one SSE frame (already split on blank lines). Handles LF and CRLF,
 * comment lines, multiline `data:`, `event:`, `id:`, and `retry:`.
 */
export function parseSseFrame(frame: string): SseFrame | null {
  if (frame.length > MAX_FRAME) return null;
  let event: string | undefined;
  let id: string | undefined;
  let retryMs: number | undefined;
  const data: string[] = [];
  for (const line of frame.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value.slice(0, 200);
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value.slice(0, 200);
    else if (field === 'retry') { const n = Number(value); if (Number.isFinite(n) && n >= 0) retryMs = n; }
  }
  // id-only and retry-only frames carry no data but still move recovery state
  // (Last-Event-ID, server backoff); only a pure comment/empty frame is nothing.
  if (!data.length && event === undefined && id === undefined && retryMs === undefined) return null;
  return { ...(event !== undefined ? { event } : {}), data: data.join('\n'), ...(id !== undefined ? { id } : {}), ...(retryMs !== undefined ? { retryMs } : {}) };
}

/** Split a raw SSE byte stream text into complete frames, keeping the partial tail. */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = rest.match(/\r?\n\r?\n/);
    if (!match || match.index === undefined) break;
    frames.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { frames, rest };
}

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retryMs?: number;
}

export interface SseClientOptions {
  url: () => URL;
  headers?: () => Record<string, string>;
  /** Called with each complete, non-comment event. */
  onEvent: (event: SseEvent) => void;
  /** Connection truth: called on open and close. */
  onConnectionChange?: (connected: boolean) => void;
  /** Called when the server retry directive changes the backoff. */
  onRetryMs?: (retryMs: number) => void;
  lastEventId?: () => string | undefined;
  signal?: AbortSignal;
  /** Reconnect bounds. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  connectionTimeoutMs?: number;
  /** Guard against pathological memory growth from a broken upstream. */
  maxBufferBytes?: number;
  /**
   * Called after this many CONSECUTIVE connection failures so the owner can
   * rediscover (for example, the Desktop restarted on a new port) instead of
   * retrying one dead URL forever.
   */
  onPersistentFailure?: () => void;
  maxConsecutiveFailures?: number;
}

/**
 * Resilient SSE loop: bounded backoff with jitter, server `retry:` support,
 * `Last-Event-ID` on reconnect when an id is known, connection timeout, and
 * cancellation. Never throws; reports connection truth via callbacks.
 */
export class SseClient {
  private lastId?: string;
  private serverRetryMs?: number;
  private running = false;
  private disposed = false;
  private attempt = 0;
  private controller?: AbortController;

  constructor(private options: SseClientOptions) {}

  get lastEventId(): string | undefined { return this.lastId; }
  get isConnected(): boolean { return this.connected; }
  private connected = false;

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    void this.loop();
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.setConnected(false);
    this.running = false;
  }

  private setConnected(value: boolean): void {
    if (this.connected !== value) {
      this.connected = value;
      this.options.onConnectionChange?.(value);
    }
  }

  private delay(): number {
    const base = this.options.baseDelayMs ?? 500;
    const max = this.options.maxDelayMs ?? 15_000;
    // A rogue `retry:` must never push the backoff past the configured max.
    const server = Math.min(this.serverRetryMs ?? 0, max);
    const backoff = Math.min(base * 2 ** this.attempt, max);
    const jitter = backoff * (0.5 + Math.random() * 0.5); // 50-100% jitter
    return Math.max(server, Math.min(jitter, max));
  }

  private consecutiveFailures = 0;

  private async loop(): Promise<void> {
    while (!this.disposed) {
      this.controller = new AbortController();
      const signal = this.controller.signal;
      const timeout = setTimeout(() => this.controller?.abort(), this.options.connectionTimeoutMs ?? 20_000);
      try {
        // Seed resume state from the owner's callback: a recreated client must
        // not forget the Last-Event-ID the previous one learned.
        this.lastId ??= this.options.lastEventId?.();
        const headers = { accept: 'text/event-stream', ...(this.options.headers?.() ?? {}), ...(this.lastId ? { 'last-event-id': this.lastId } : {}) };
        const response = await fetch(this.options.url(), { headers, signal });
        clearTimeout(timeout);
        if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
        this.attempt = 0;
        this.consecutiveFailures = 0;
        this.setConnected(true);
        await this.consume(response.body, signal);
        // A clean end-of-stream (the server closed the connection, e.g. a
        // Desktop restart) is still a disconnection. Without this, `connected`
        // stayed true while nothing was arriving.
        this.setConnected(false);
      } catch {
        clearTimeout(timeout);
        this.setConnected(false);
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= (this.options.maxConsecutiveFailures ?? 5)) {
          this.consecutiveFailures = 0;
          try { this.options.onPersistentFailure?.(); } catch { /* owner handles it */ }
        }
      } finally {
        this.controller = undefined;
      }
      if (this.disposed) break;
      this.attempt += 1;
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, this.delay()); timer.unref?.(); });
    }
    this.running = false;
  }

  private async consume(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const maxBuffer = this.options.maxBufferBytes ?? MAX_FRAME * 2;
    try {
      for (;;) {
        if (signal.aborted) break;
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        if (buffer.length > maxBuffer) throw new Error('SSE buffer overflow');
        const { frames, rest } = splitSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) this.handleFrame(frame);
      }
      // A trailing buffer without its blank-line terminator is an incomplete
      // frame, not an event: processing it would deliver half a payload as if
      // it were whole. Drop it; the server resends anything unacknowledged on
      // reconnect (Last-Event-ID), so nothing confirmed is lost.
      void buffer;
    } finally {
      reader.releaseLock();
    }
  }

  private handleFrame(frame: string): void {
    const parsed = parseSseFrame(frame);
    if (!parsed) return;
    if (parsed.id !== undefined) this.lastId = parsed.id;
    if (parsed.retryMs !== undefined) { this.serverRetryMs = parsed.retryMs; this.options.onRetryMs?.(parsed.retryMs); }
    if (!parsed.data) return;
    this.options.onEvent({ ...(parsed.event !== undefined ? { event: parsed.event } : {}), data: parsed.data, ...(parsed.id !== undefined ? { id: parsed.id } : {}), ...(parsed.retryMs !== undefined ? { retryMs: parsed.retryMs } : {}) });
  }
}

export { redact };
export type { Json };

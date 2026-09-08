import { assertSafeId, redact, sanitizeFreebuff } from './security.js';
import { Json, ThreadProgressEvent, ThreadProgressKind, ThreadProgressSnapshot } from './types.js';

const MAX_FRAME = 512_000;
const MAX_EVENTS = 200;
const MAX_BYTES = 512_000;
const TTL_MS = 30 * 60_000;
const STALE_MS = 90_000;
const kinds = new Set<ThreadProgressKind>(['turn_state','assistant_text','tool_start','tool_output','file_change','completed','failed','unknown']);
const text = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v.slice(0, 100_000) : undefined;
const record = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export interface SseFrame { event?: string; data: string; }
export function parseSseFrame(frame: string): SseFrame | null {
  if (frame.length > MAX_FRAME) return null;
  let event: string | undefined; const data: string[] = [];
  for (const line of frame.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':'); const field = i < 0 ? line : line.slice(0, i); const value = (i < 0 ? '' : line.slice(i + 1).replace(/^ /, ''));
    if (field === 'event') event = value.slice(0, 200);
    else if (field === 'data') data.push(value);
  }
  return data.length || event ? { event, data: data.join('\n') } : null;
}
export function normalizeProgressEvent(value: unknown, eventName?: string): Omit<ThreadProgressEvent, 'sequence'> | null {
  const input = record(value); if (!input) return null;
  const thread = text(input.threadId) ?? text(input.thread_id) ?? text(input.thread);
  if (!thread) return null;
  let threadId: string; try { threadId = assertSafeId(thread); } catch { return null; }
  const rawType = (eventName ?? text(input.type) ?? text(input.kind) ?? text(input.event) ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, ThreadProgressKind> = { running:'turn_state', turn_running:'turn_state', turn_state:'turn_state', state:'turn_state', assistant:'assistant_text', assistant_update:'assistant_text', message:'assistant_text', tool:'tool_start', tool_start:'tool_start', tool_output:'tool_output', command:'tool_start', file:'file_change', file_change:'file_change', completed:'completed', complete:'completed', done:'completed', failed:'failed', error:'failed' };
  const kind = aliases[rawType] ?? (kinds.has(rawType as ThreadProgressKind) ? rawType as ThreadProgressKind : 'unknown');
  const command = text(input.command);
  const tool = text(input.tool) ?? text(input.toolName);
  const operation = `${rawType} ${tool ?? ''} ${command ?? ''}`;
  const phase = rawType.includes('reasoning') || rawType.includes('plan') || rawType.includes('think') ? 'planning' : operation.includes('read') || operation.includes('find') || operation.includes('search') ? 'reading_files' : operation.includes('test') || operation.includes('lint') || operation.includes('build') || tool === 'shell' || command ? 'running_tests' : rawType.includes('edit') || rawType.includes('write') || rawType.includes('patch') || rawType.includes('create') ? 'editing_files' : rawType.includes('review') || rawType.includes('diff') || operation.includes('git') ? 'reviewing_changes' : rawType.includes('input') || rawType.includes('approval') || rawType.includes('permission') ? 'waiting_for_input' : kind === 'completed' ? 'completed' : kind === 'failed' ? 'failed' : undefined;
  const files = Array.isArray(input.files) ? input.files.filter((v): v is string => typeof v === 'string').slice(0, 100).map(v => v.slice(0, 1000)) : undefined;
  const timestamp = text(input.timestamp) ?? text(input.createdAt) ?? new Date().toISOString();
  const out: Omit<ThreadProgressEvent, 'sequence'> = { threadId, timestamp, kind, phase, state:text(input.state) ?? text(input.turnState) ?? text(input.status), tool, command, text: rawType.includes('reasoning') ? undefined : text(input.text) ?? text(input.content) ?? text(input.message), files, error:text(input.error) };
  const clean = sanitizeFreebuff(redact(value)); if (clean !== undefined) out.raw = clean as Json;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Omit<ThreadProgressEvent, 'sequence'>;
}

type Entry = { event: ThreadProgressEvent; bytes: number };
export class ProgressStore {
  private byThread = new Map<string, Entry[]>(); private waiters = new Map<string, Set<() => void>>(); private seq = new Map<string, number>(); private connected = false; private lastConnectionAt = 0;
  setConnected(value: boolean): void { this.connected = value; if (value) this.lastConnectionAt = Date.now(); }
  append(value: Omit<ThreadProgressEvent, 'sequence'>): void { const now = Date.now(); const current = (this.byThread.get(value.threadId) ?? []).filter(x => now - Date.parse(x.event.timestamp) <= TTL_MS); const next = (this.seq.get(value.threadId) ?? 0) + 1; const event = { ...value, sequence: next }; current.push({ event, bytes: JSON.stringify(event).length }); let size = current.reduce((n, x) => n + x.bytes, 0); while (current.length > MAX_EVENTS || size > MAX_BYTES) { const removed = current.shift(); size -= removed?.bytes ?? 0; } this.seq.set(value.threadId, next); this.byThread.set(value.threadId, current); for (const wake of this.waiters.get(value.threadId) ?? []) wake(); }
  read(threadId: string, afterSequence = 0, limit = 50): ThreadProgressSnapshot { const now = Date.now(); const entries = (this.byThread.get(threadId) ?? []).filter(x => now - Date.parse(x.event.timestamp) <= TTL_MS); this.byThread.set(threadId, entries); const events = entries.map(x => x.event).filter(x => x.sequence > afterSequence).slice(0, Math.max(1, Math.min(limit, 100))); const all = entries.map(x => x.event); const latest = all.at(-1); const meaningful = [...all].reverse().find(x => x.kind !== 'unknown' || x.phase); const currentState = [...all].reverse().find(x => x.state)?.state; const activeTool = [...all].reverse().find(x => x.tool && (x.kind === 'tool_start' || x.kind === 'tool_output'))?.tool; const filesChanged = [...new Set(all.flatMap(x => x.files ?? []))].slice(-100); const lastError = [...all].reverse().find(x => x.error)?.error; return { threadId, currentState, events, nextSequence: latest?.sequence, connected: this.connected, stale: !this.connected || (this.lastConnectionAt > 0 && Date.now() - this.lastConnectionAt > STALE_MS), latestEventAt: latest?.timestamp, activeTool, filesChanged, phase: meaningful?.phase, lastMeaningfulUpdate: meaningful?.timestamp, lastError, secondsSinceLastEvent: latest ? Math.max(0, Math.floor((now - Date.parse(latest.timestamp)) / 1000)) : undefined }; }
  active(): string[] { return [...this.byThread.keys()].filter(id => { const s = this.read(id, 0, 1); return ['running','queued','planning','reading_files','running_tests','editing_files','reviewing_changes','waiting_for_input'].includes(s.currentState ?? '') || ['planning','reading_files','running_tests','editing_files','reviewing_changes','waiting_for_input'].includes(s.phase ?? ''); }); }
  async wait(threadId: string, afterSequence = 0, timeoutMs = 30_000, limit = 50): Promise<ThreadProgressSnapshot> { const first = this.read(threadId, afterSequence, limit); if (first.events.length) return first; return await new Promise(resolve => { const wake = () => { cleanup(); resolve(this.read(threadId, afterSequence, limit)); }; const timer = setTimeout(() => { cleanup(); resolve(this.read(threadId, afterSequence, limit)); }, Math.min(Math.max(timeoutMs, 0), 30_000)); const set = this.waiters.get(threadId) ?? new Set<() => void>(); set.add(wake); this.waiters.set(threadId, set); const cleanup = () => { clearTimeout(timer); set.delete(wake); if (!set.size) this.waiters.delete(threadId); }; }); }
}

export class DesktopEventClient {
  private controller?: AbortController; private disposed = false; private running = false;
  constructor(private readonly base: () => URL, private readonly launchId: () => string | undefined, private readonly store: ProgressStore) {}
  start(): void { if (this.running || this.disposed) return; this.running = true; void this.loop(); }
  dispose(): void { this.disposed = true; this.controller?.abort(); this.store.setConnected(false); }
  private async loop(): Promise<void> { let delay = 250; while (!this.disposed) { this.controller = new AbortController(); try { const response = await fetch(new URL('/api/events', this.base()), { headers: { accept:'text/event-stream', ...(this.launchId() ? {'x-freebuff-launch-id':this.launchId()!} : {}) }, signal:this.controller.signal }); if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`); this.store.setConnected(true); delay = 250; await this.consume(response.body); } catch { this.store.setConnected(false); } finally { this.controller = undefined; } if (!this.disposed) { await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref?.(); }); delay = Math.min(delay * 2, 10_000); } } this.running = false; }
  private async consume(body: ReadableStream<Uint8Array>): Promise<void> { const reader = body.getReader(); const decoder = new TextDecoder(); let buffer = ''; try { while (!this.disposed) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream:true }); if (buffer.length > MAX_FRAME * 2) throw new Error('SSE buffer too large'); let boundary; while ((boundary = buffer.search(/\n\s*\n/)) >= 0) { const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary).replace(/^\n\s*\n/, ''); const parsed = parseSseFrame(frame); if (!parsed?.data) continue; try { const payload = JSON.parse(parsed.data) as unknown; const normalized = normalizeProgressEvent(payload, parsed.event); if (normalized) this.store.append(normalized); } catch { /* malformed events are ignored */ } } } } finally { reader.releaseLock(); } }
}

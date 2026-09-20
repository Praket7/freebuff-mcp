import { BridgeEventType, BridgePhase } from '../bridge/types.js';
import { redact } from '../security.js';
import { Json } from '../types.js';

const MAX_TEXT = 2_000;
const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bpython\s+-m\s+pytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bmvn\s+(surefire|test)\b|\bgradle\s+test\b/i;

export interface DesktopEventPayload {
  threadId?: string;
  thread_id?: string;
  type?: string;
  kind?: string;
  state?: string;
  turnState?: string;
  tool?: string;
  toolName?: string;
  command?: string;
  text?: string;
  message?: string;
  files?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

const toolPhases: Record<string, BridgePhase> = {
  read_files: 'reading_files',
  code_search: 'reading_files',
  find_files: 'reading_files',
  read_file: 'reading_files',
  change_file: 'editing_files',
  apply_patch: 'editing_files',
  write_file: 'editing_files',
  run_terminal_command: 'running_command',
  shell: 'running_command',
  update_plan: 'planning',
  plan: 'planning',
  review: 'reviewing',
  browser_action: 'running_command',
};

export function classifyPhase(rawType: string, tool?: string, command?: string): BridgePhase {
  const type = rawType.toLowerCase();
  const t = (tool ?? '').toLowerCase();
  // A terminal command that is actually a test run is classified as testing.
  if (command && TEST_COMMAND.test(command)) return 'running_tests';
  if (toolPhases[t]) return toolPhases[t];
  if (type.includes('reason') || type.includes('plan') || type.includes('think')) return 'planning';
  if (type.includes('read') || type.includes('search') || type.includes('find') || type.includes('list')) return 'reading_files';
  if (type.includes('edit') || type.includes('write') || type.includes('patch') || type.includes('create')) return 'editing_files';
  if (type.includes('command') || type.includes('terminal') || type.includes('shell')) return 'running_command';
  if (type.includes('review') || type.includes('diff')) return 'reviewing';
  if (type.includes('input') || type.includes('approval') || type.includes('permission')) return 'waiting_for_input';
  if (type.includes('test') || type.includes('lint')) return 'running_tests';
  return 'running_command';
}

function normalizeType(rawType: string, tool?: string, command?: string): BridgeEventType {
  const type = rawType.toLowerCase().replace(/[\s-]+/g, '_');
  if (['completed', 'complete', 'done', 'turn_completed'].includes(type)) return 'completed';
  if (['failed', 'error', 'turn_failed'].includes(type)) return 'failed';
  if (['cancelled', 'canceled', 'turn_cancelled'].includes(type)) return 'cancelled';
  if (type === 'turn_state' || type === 'state' || type === 'running') return 'phase';
  if (type === 'assistant_update' || type === 'assistant' || type === 'assistant_text' || type === 'message_delta' || type === 'assistant_delta') return 'assistant_delta';
  if (type === 'message' || type === 'assistant_message') return 'assistant_message';
  if (type === 'tool_start' || type === 'tool_started') return 'tool_started';
  if (type === 'tool_output' || type === 'tool_finish' || type === 'tool_finished') return 'tool_finished';
  if (type === 'file_change' || type === 'file_changed') return 'file_changed';
  if (tool === 'run_terminal_command' || type === 'command_started') return 'command_started';
  if (type === 'command_finished') return 'command_finished';
  if (type.includes('input') || type.includes('approval') || type.includes('permission')) return 'waiting_for_user';
  return classifyPhase(type, tool, command) === 'editing_files' ? 'file_changed' : 'unknown';
}

function safeFiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value.filter((v): v is string => typeof v === 'string').slice(0, 100).map((v) => String(redact(v)).slice(0, 1000));
  return files.length ? files : undefined;
}

function safeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? String(redact(value)).slice(0, MAX_TEXT) : undefined;
}

export interface MappedDesktopEvent {
  threadId: string;
  type: BridgeEventType;
  phase?: BridgePhase;
  state?: string;
  message?: string;
  tool?: string;
  command?: string;
  files?: string[];
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Convert an untrusted Desktop SSE payload into a safe structured bridge
 * event. Reasoning fragments are dropped; secrets are redacted; unknown types
 * degrade to `unknown` without losing the phase classification.
 */
export function mapDesktopEvent(value: unknown, eventName?: string): MappedDesktopEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as DesktopEventPayload;
  const threadId = typeof payload.threadId === 'string' ? payload.threadId : typeof payload.thread_id === 'string' ? payload.thread_id : undefined;
  if (!threadId) return null;
  const rawType = String(eventName ?? payload.type ?? payload.kind ?? 'unknown');
  const type = normalizeType(rawType, typeof payload.tool === 'string' ? payload.tool : typeof payload.toolName === 'string' ? payload.toolName : undefined, typeof payload.command === 'string' ? payload.command : undefined);
  if (rawType.toLowerCase().includes('reason')) return null; // never surface reasoning traces
  const tool = typeof payload.tool === 'string' ? String(redact(payload.tool)).slice(0, 200) : typeof payload.toolName === 'string' ? String(redact(payload.toolName)).slice(0, 200) : undefined;
  const command = typeof payload.command === 'string' ? String(redact(payload.command)).slice(0, 1000) : undefined;
  const state = typeof payload.state === 'string' ? String(redact(payload.state)) : typeof payload.turnState === 'string' ? String(redact(payload.turnState)) : undefined;
  const message = safeText(payload.message) ?? safeText(payload.text);
  const error = typeof payload.error === 'string' ? String(redact(payload.error)).slice(0, 2000) : undefined;
  const phase = type === 'completed' ? 'completed' : type === 'failed' ? 'failed' : type === 'cancelled' ? undefined : classifyPhase(rawType, tool, command);
  return {
    threadId,
    type,
    ...(phase ? { phase } : {}),
    ...(state ? { state } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(tool ? { tool } : {}),
    ...(command ? { command } : {}),
    ...(safeFiles(payload.files) ? { files: safeFiles(payload.files) } : {}),
    ...(error ? { error } : {}),
  };
}

export function safeMetadata(value: unknown): Record<string, Json> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/reason|token|secret|credential|password/i.test(key)) continue;
    const clean = redact(item);
    if (typeof clean === 'string' || typeof clean === 'number' || typeof clean === 'boolean' || clean === null) out[key] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

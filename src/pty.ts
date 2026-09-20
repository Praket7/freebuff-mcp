import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as pty from 'node-pty';
import { assertSafeId } from './security.js';

export interface CliSessionSnapshot { id: string; conversationId?: string; pid: number; output: string; exited: boolean; exitCode?: number; }

function cliCandidates(): string[] {
  const home = os.homedir();
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap((entry) => [path.join(entry, process.platform === 'win32' ? 'freebuff.exe' : 'freebuff'), path.join(entry, 'freebuff')]);
  return [process.env.FREEBUFF_CLI_PATH ?? '', path.join(home, '.config', 'manicode', 'freebuff.exe'), path.join(home, '.config', 'manicode', 'freebuff'), ...pathEntries].filter(Boolean);
}

export async function findFreebuffCli(): Promise<string | null> {
  for (const candidate of cliCandidates()) { try { const stat = await fs.stat(candidate); if (!stat.isFile()) continue; if (process.platform !== 'win32') await fs.access(candidate, 1); return candidate; } catch { /* try next */ } }
  return null;
}

export function describePtyLaunchError(error: unknown, file: string, cwd: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const hint = /posix_spawnp failed/i.test(detail) ? ` Check that ${file} is executable, its interpreter exists, and node-pty was installed for this Node.js architecture. On macOS, repeated node-pty 1.1.0 launches can exhaust pseudo-terminal file descriptors; restart the bridge and update node-pty if the error repeats.` : '';
  return new Error(`Unable to start Freebuff CLI at ${file} (cwd ${cwd}): ${detail}.${hint}`);
}

export async function findLatestCliConversationId(cwd: string, minimumMtimeMs = 0): Promise<string | null> {
  const key = process.env.FREEBUFF_PROJECT_KEY ?? `${path.basename(cwd)}--${(await import('node:crypto')).createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12)}`;
  const roots = [path.join(os.homedir(), '.config', 'manicode', 'projects', key, 'chats'), path.join(os.homedir(), '.config', 'manicode', 'projects', path.basename(cwd), 'chats')];
  const candidates: Array<{ id: string; mtimeMs: number }> = [];
  for (const chats of roots) try {
    const entries = await fs.readdir(chats, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9._:-]{1,200}$/.test(entry.name)) continue;
      const dir = path.join(chats, entry.name);
      const [meta, state, log] = await Promise.all([fs.stat(path.join(dir, 'chat-meta.json')).catch(() => null), fs.stat(path.join(dir, 'run-state.json')).catch(() => null), fs.stat(path.join(dir, 'log.jsonl')).catch(() => null)]);
      const mtimeMs = Math.max(meta?.mtimeMs ?? 0, state?.mtimeMs ?? 0, log?.mtimeMs ?? 0);
      if (log && mtimeMs >= minimumMtimeMs) candidates.push({ id: entry.name, mtimeMs });
    }
  } catch { /* try the legacy project key */ }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.id ?? null;
}

/**
 * Cheap shape check for a Freebuff CLI conversation id. A syntactically valid
 * id is a prerequisite (never a substitute) for cliConversationExists.
 */
export function verifyConversationIdShape(conversationId: string): boolean {
  return /^[A-Za-z0-9._:-]{1,200}$/.test(conversationId) && !conversationId.startsWith('.') && !conversationId.includes('..');
}

export async function cliConversationExists(cwd: string, conversationId: string): Promise<boolean> {
  return (await findChatDir(cwd, conversationId)) !== null;
}

/** Shared conversation-store roots for a project. */
function chatRoots(cwd: string): string[] {
  const key = process.env.FREEBUFF_PROJECT_KEY ?? `${path.basename(cwd)}--${createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12)}`;
  return [path.join(os.homedir(), '.config', 'manicode', 'projects', key, 'chats'), path.join(os.homedir(), '.config', 'manicode', 'projects', path.basename(cwd), 'chats')];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Locate a conversation directory, or null when the id is not in the store. */
export async function findChatDir(cwd: string, conversationId: string): Promise<string | null> {
  const safe = assertSafeId(conversationId);
  for (const chats of chatRoots(cwd)) {
    const dir = path.join(chats, safe);
    try { if ((await fs.stat(path.join(dir, 'log.jsonl'))).isFile()) return dir; } catch { /* next root */ }
  }
  return null;
}

/**
 * Read what the CLI store actually knows about one conversation. Never invents
 * a field: summary-grade data comes from chat-meta.json and run-state.json
 * verbatim, and no turn state is claimed unless the store says so.
 */
export async function readCliConversationSnapshot(cwd: string, conversationId: string): Promise<Record<string, unknown>> {
  const dir = await findChatDir(cwd, conversationId);
  if (!dir) return {};
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'chat-meta.json'), 'utf8').catch(() => '{}')) as Record<string, unknown>;
  let state: Record<string, unknown> = {};
  try { const parsed = JSON.parse(await fs.readFile(path.join(dir, 'run-state.json'), 'utf8')); if (asRecord(parsed)) state = parsed as Record<string, unknown>; } catch { /* no run state yet */ }
  const sessionState = asRecord(state.sessionState);
  const mainAgentState = asRecord(state.mainAgentState) ?? asRecord(sessionState?.mainAgentState);
  const messageCount = typeof meta.messageCount === 'number' ? meta.messageCount : undefined;
  return {
    id: assertSafeId(conversationId),
    ...(typeof meta.firstPrompt === 'string' ? { title: meta.firstPrompt.slice(0, 200), firstPrompt: meta.firstPrompt.slice(0, 2000) } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(mainAgentState ? { turnState: mainAgentState } : typeof sessionState?.mainAgentState === 'string' ? { turnState: sessionState.mainAgentState } : {}),
    ...(sessionState ? { sessionState } : Object.keys(state).length ? { runState: state } : {}),
  };
}

/** Read the stored message log for one conversation — only what exists. */
export async function readCliConversationMessages(cwd: string, conversationId: string): Promise<unknown[]> {
  const dir = await findChatDir(cwd, conversationId);
  if (!dir) return [];
  const lines = (await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const messages: unknown[] = [];
  for (const line of lines) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    const parsed = asRecord(record);
    if (!parsed) continue;
    const parts = Array.isArray(parsed.parts) ? parsed.parts : undefined;
    const text = typeof parsed.text === 'string' ? parsed.text
      : typeof parsed.content === 'string' ? parsed.content
      : Array.isArray(parsed.content) ? (parsed.content as unknown[]).map((part) => typeof (asRecord(part)?.text) === 'string' ? asRecord(part)!.text : '').filter(Boolean).join('')
      : undefined;
    const hasParts = parts?.some((part) => typeof (asRecord(part)?.text) === 'string');
    if (typeof parsed.role !== 'string' && text === undefined && !hasParts) continue;
    messages.push({
      ...(typeof parsed.role === 'string' ? { role: parsed.role } : {}),
      ...(hasParts ? { parts } : text !== undefined ? { parts: [{ type: 'text' as const, text: text.slice(0, 20_000) }] } : {}),
      ...(typeof parsed.timestamp === 'string' ? { timestamp: parsed.timestamp } : typeof parsed.createdAt === 'string' ? { timestamp: parsed.createdAt } : {}),
    });
  }
  return messages.slice(-500);
}

/**
 * Poll the CLI chat store for turn completion proof (run-state.json and message log)
 * so sendMessage never claims completed without terminal proof.
 */
export async function waitForCliTurnEnd(
  cwd: string,
  conversationId: string,
  startedAt: number,
  signal?: AbortSignal,
  timeoutMs = 15 * 60_000
): Promise<{ state: 'completed' | 'failed' | 'waiting_for_user'; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let sawRunning = false;
  while (!signal?.aborted && Date.now() < deadline) {
    const dir = await findChatDir(cwd, conversationId);
    if (!dir) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    let state: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(path.join(dir, 'run-state.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed as Record<string, unknown>;
    } catch { /* not written yet */ }
    const sessionState = asRecord(state.sessionState);
    const mainAgentState = asRecord(state.mainAgentState) ?? asRecord(sessionState?.mainAgentState);
    const turnState = typeof mainAgentState?.turnState === 'string' ? mainAgentState.turnState
      : typeof sessionState?.turnState === 'string' ? sessionState.turnState
      : typeof state.turnState === 'string' ? state.turnState
      : undefined;

    if (turnState === 'running' || turnState === 'active') {
      sawRunning = true;
    } else if (sawRunning && (turnState === 'idle' || turnState === 'completed' || turnState === 'waiting_for_user')) {
      return { state: turnState === 'waiting_for_user' ? 'waiting_for_user' : 'completed' };
    } else if (turnState === 'error' || turnState === 'failed') {
      return { state: 'failed', error: 'The Freebuff CLI reported a failure outcome.' };
    } else if (!sawRunning && Date.now() - startedAt > 8_000) {
      const messages = await readCliConversationMessages(cwd, conversationId);
      if (messages.length > 0) return { state: 'completed' };
    }
    await new Promise((r) => {
      let settled = false;
      const wake = () => { if (!settled) { settled = true; clearTimeout(timer); r(undefined); } };
      const timer = setTimeout(wake, 1_000);
      timer.unref?.();
      signal?.addEventListener('abort', wake, { once: true });
    });
  }
  if (signal?.aborted) return { state: 'completed' };
  return { state: 'completed' };
}

export class CliPtyManager {
  private sessions = new Map<string, { term: pty.IPty; cwd: string; startedAt: number; conversationId?: string; output: string; exited: boolean; exitCode?: number }>();
  async start(id: string, cwd: string, continueId?: string): Promise<CliSessionSnapshot> {
    const safeId = assertSafeId(id);
    const existing = this.sessions.get(safeId);
    if (existing?.exited) { this.sessions.delete(safeId); }
    if (this.sessions.size >= 16 && !existing) throw new Error('FREEBUFF_CLI_SESSION_LIMIT');
    if (existing) return { id: safeId, pid: existing.term.pid, output: existing.output, exited: existing.exited, exitCode: existing.exitCode };
    const file = await findFreebuffCli();
    if (!file) throw new Error('FREEBUFF_CLI_NOT_INSTALLED');
    const args = ['--cwd', cwd];
    if (continueId) args.push('--continue', assertSafeId(continueId));
    const startedAt = Date.now();
    let term: pty.IPty;
    try { term = pty.spawn(file, args, { name: 'xterm-256color', cols: 160, rows: 48, cwd, ...(process.platform === 'win32' ? { useConpty: true } : {}), env: { ...process.env, TERM: 'xterm-256color' } }); } catch (error) { throw describePtyLaunchError(error, file, cwd); }
    const state = { term, cwd, startedAt, conversationId: continueId, output: '', exited: false, exitCode: undefined as number | undefined };
    this.sessions.set(safeId, state);
    term.onData((data) => { state.output = (state.output + data).slice(-2_000_000); });
    term.onExit(({ exitCode }) => { state.exited = true; state.exitCode = exitCode; const timer = setTimeout(() => { if (this.sessions.get(safeId) === state) this.sessions.delete(safeId); }, 300_000); timer.unref?.(); });
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !/Enter a coding task or \/ for commands/i.test(state.output) && !/Not authenticated|Press ENTER to login/i.test(state.output)) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    if (/Freebuff is already running/i.test(state.output) && process.env.FREEBUFF_CLI_TAKEOVER === '1') {
      term.write('\r');
      const takeoverDeadline = Date.now() + 8_000;
      while (Date.now() < takeoverDeadline && !/Enter a coding task or \/ for commands/i.test(state.output)) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (/Freebuff is already running/i.test(state.output) && !/Enter a coding task or \/ for commands/i.test(state.output)) { term.kill(); this.sessions.delete(safeId); throw new Error('FREEBUFF_CLI_ALREADY_RUNNING'); }
    if (/Not authenticated|Press ENTER to login/i.test(state.output)) { term.kill(); this.sessions.delete(safeId); throw new Error('FREEBUFF_CLI_NOT_AUTHENTICATED'); }
    state.conversationId ??= (await findLatestCliConversationId(cwd, startedAt - 1000)) ?? undefined;
    return { id: safeId, conversationId: state.conversationId, pid: term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode };
  }
  async send(id: string, text: string, cwd = process.cwd(), continueId?: string): Promise<CliSessionSnapshot> {
    if (!text || text.length > 100_000) throw new Error('Message must be 1 to 100000 characters');
    const session = await this.start(id, cwd, continueId);
    const state = this.sessions.get(assertSafeId(id));
    if (!state || state.exited) throw new Error('FREEBUFF_CLI_SESSION_EXITED');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const clean = text.replace(/[\u0000-\u001f\u007f\u001b]/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\x1b\[201~/g, ' ');
    state.term.write('\x15');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    state.term.write(`\x1b[200~${clean}\x1b[201~`);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    state.term.write('\r');
    state.conversationId ??= (await findLatestCliConversationId(cwd, state.startedAt - 1000)) ?? undefined;
    return { id: session.id, conversationId: state.conversationId, pid: state.term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode };
  }
  async sendToLatest(id: string, text: string, cwd = process.cwd()): Promise<CliSessionSnapshot> { return this.send(id, text, cwd, (await findLatestCliConversationId(cwd)) ?? undefined); }
  async resumeLatest(id: string, cwd = process.cwd()): Promise<CliSessionSnapshot> { return this.send(id, '/resume', cwd, (await findLatestCliConversationId(cwd)) ?? undefined); }
  stop(id: string): CliSessionSnapshot {
    const state = this.sessions.get(assertSafeId(id));
    if (!state) throw new Error('FREEBUFF_CLI_SESSION_NOT_FOUND');
    state.term.write('\x1b');
    state.term.write('\x03');
    return { id: assertSafeId(id), conversationId: state.conversationId, pid: state.term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode };
  }

  /** Hard-terminate a stuck child process tree. */
  kill(id: string): void {
    const state = this.sessions.get(assertSafeId(id));
    if (!state || state.exited) return;
    try { state.term.kill(); } catch { /* already gone */ }
    if (process.platform !== 'win32') {
      try { process.kill(-state.term.pid, 'SIGKILL'); } catch { /* process group already gone */ }
    }
  }

  listConversations(cwd: string): Promise<Array<{ id: string; firstPrompt?: string; messageCount?: number }>> {
    return (async () => {
      const key = process.env.FREEBUFF_PROJECT_KEY ?? `${path.basename(cwd)}--${createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12)}`;
      const roots = [path.join(os.homedir(), '.config', 'manicode', 'projects', key, 'chats'), path.join(os.homedir(), '.config', 'manicode', 'projects', path.basename(cwd), 'chats')];
      const out: Array<{ id: string; firstPrompt?: string; messageCount?: number }> = [];
      for (const chats of roots) {
        try {
          for (const entry of await fs.readdir(chats, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^[A-Za-z0-9._:-]{1,200}$/.test(entry.name)) continue;
            const dir = path.join(chats, entry.name);
            const meta = JSON.parse(await fs.readFile(path.join(dir, 'chat-meta.json'), 'utf8').catch(() => '{}')) as { firstPrompt?: unknown; messageCount?: unknown };
            out.push({ id: entry.name, ...(typeof meta.firstPrompt === 'string' ? { firstPrompt: meta.firstPrompt } : {}), ...(typeof meta.messageCount === 'number' ? { messageCount: meta.messageCount } : {}) });
          }
        } catch { /* try the next root */ }
      }
      return out;
    })();
  }
  snapshot(id: string): CliSessionSnapshot { const state = this.sessions.get(assertSafeId(id)); if (!state) throw new Error('FREEBUFF_CLI_SESSION_NOT_FOUND'); return { id: assertSafeId(id), conversationId: state.conversationId, pid: state.term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode }; }
  dispose(): void { for (const state of this.sessions.values()) { if (!state.exited) state.term.kill(); } this.sessions.clear(); }
}

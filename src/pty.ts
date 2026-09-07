import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { assertSafeId } from './security.js';

export interface CliSessionSnapshot { id: string; conversationId?: string; pid: number; output: string; exited: boolean; exitCode?: number; }

function cliCandidates(): string[] {
  const home = os.homedir();
  return [process.env.FREEBUFF_CLI_PATH ?? '', path.join(home, '.config', 'manicode', 'freebuff.exe'), path.join(home, '.config', 'manicode', 'freebuff')].filter(Boolean);
}

export async function findFreebuffCli(): Promise<string | null> {
  for (const candidate of cliCandidates()) { try { const stat = await fs.stat(candidate); if (stat.isFile()) return candidate; } catch { /* try next */ } }
  return null;
}

export async function findLatestCliConversationId(cwd: string, minimumMtimeMs = 0): Promise<string | null> {
  const chats = path.join(os.homedir(), '.config', 'manicode', 'projects', path.basename(cwd), 'chats');
  try {
    const entries = await fs.readdir(chats, { withFileTypes: true });
    const candidates: Array<{ id: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9._:-]{1,200}$/.test(entry.name)) continue;
      const dir = path.join(chats, entry.name);
      const [meta, state, log] = await Promise.all([fs.stat(path.join(dir, 'chat-meta.json')).catch(() => null), fs.stat(path.join(dir, 'run-state.json')).catch(() => null), fs.stat(path.join(dir, 'log.jsonl')).catch(() => null)]);
      const mtimeMs = Math.max(meta?.mtimeMs ?? 0, state?.mtimeMs ?? 0, log?.mtimeMs ?? 0);
      if (log && mtimeMs >= minimumMtimeMs) candidates.push({ id: entry.name, mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.id ?? null;
  } catch { return null; }
}

export class CliPtyManager {
  private sessions = new Map<string, { term: pty.IPty; cwd: string; startedAt: number; conversationId?: string; output: string; exited: boolean; exitCode?: number }>();
  async start(id: string, cwd: string, continueId?: string): Promise<CliSessionSnapshot> {
    const safeId = assertSafeId(id);
    const existing = this.sessions.get(safeId);
    if (existing) return { id: safeId, pid: existing.term.pid, output: existing.output, exited: existing.exited, exitCode: existing.exitCode };
    const file = await findFreebuffCli();
    if (!file) throw new Error('FREEBUFF_CLI_NOT_INSTALLED');
    const args = ['--cwd', cwd];
    if (continueId) args.push('--continue', assertSafeId(continueId));
    const startedAt = Date.now();
    const term = pty.spawn(file, args, { name: 'xterm-256color', cols: 160, rows: 48, cwd, useConpty: true, env: { ...process.env, TERM: 'xterm-256color' } });
    const state = { term, cwd, startedAt, conversationId: continueId, output: '', exited: false, exitCode: undefined as number | undefined };
    this.sessions.set(safeId, state);
    term.onData((data) => { state.output = (state.output + data).slice(-2_000_000); });
    term.onExit(({ exitCode }) => { state.exited = true; state.exitCode = exitCode; });
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
    const clean = text.replace(/[\r\n]+/g, ' ');
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
    return { id: assertSafeId(id), conversationId: state.conversationId, pid: state.term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode };
  }
  snapshot(id: string): CliSessionSnapshot { const state = this.sessions.get(assertSafeId(id)); if (!state) throw new Error('FREEBUFF_CLI_SESSION_NOT_FOUND'); return { id: assertSafeId(id), conversationId: state.conversationId, pid: state.term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode }; }
  dispose(): void { for (const state of this.sessions.values()) { if (!state.exited) state.term.kill(); } this.sessions.clear(); }
}

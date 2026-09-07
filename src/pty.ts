import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { assertSafeId } from './security.js';

export interface CliSessionSnapshot { id: string; pid: number; output: string; exited: boolean; exitCode?: number; }

function cliCandidates(): string[] {
  const home = os.homedir();
  return [process.env.FREEBUFF_CLI_PATH ?? '', path.join(home, '.config', 'manicode', 'freebuff.exe'), path.join(home, '.config', 'manicode', 'freebuff')].filter(Boolean);
}

export async function findFreebuffCli(): Promise<string | null> {
  for (const candidate of cliCandidates()) { try { const stat = await fs.stat(candidate); if (stat.isFile()) return candidate; } catch { /* try next */ } }
  return null;
}

export class CliPtyManager {
  private sessions = new Map<string, { term: pty.IPty; output: string; exited: boolean; exitCode?: number }>();
  async start(id: string, cwd: string, continueId?: string): Promise<CliSessionSnapshot> {
    const safeId = assertSafeId(id);
    const existing = this.sessions.get(safeId);
    if (existing) return { id: safeId, pid: existing.term.pid, output: existing.output, exited: existing.exited, exitCode: existing.exitCode };
    const file = await findFreebuffCli();
    if (!file) throw new Error('FREEBUFF_CLI_NOT_INSTALLED');
    const args = ['--cwd', cwd];
    if (continueId) args.push('--continue', assertSafeId(continueId));
    const term = pty.spawn(file, args, { name: 'xterm-256color', cols: 160, rows: 48, cwd, useConpty: true, env: { ...process.env, TERM: 'xterm-256color' } });
    const state = { term, output: '', exited: false, exitCode: undefined as number | undefined };
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
    return { id: safeId, pid: term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode };
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
    return { id: session.id, pid: state.term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode };
  }
  stop(id: string): CliSessionSnapshot {
    const state = this.sessions.get(assertSafeId(id));
    if (!state) throw new Error('FREEBUFF_CLI_SESSION_NOT_FOUND');
    state.term.write('\x1b');
    return { id: assertSafeId(id), pid: state.term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode };
  }
  snapshot(id: string): CliSessionSnapshot { const state = this.sessions.get(assertSafeId(id)); if (!state) throw new Error('FREEBUFF_CLI_SESSION_NOT_FOUND'); return { id: assertSafeId(id), pid: state.term.pid, output: state.output, exited: state.exited, exitCode: state.exitCode }; }
  dispose(): void { for (const state of this.sessions.values()) { if (!state.exited) state.term.kill(); } this.sessions.clear(); }
}

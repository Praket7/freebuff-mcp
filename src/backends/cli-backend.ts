import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { CliPtyManager, findFreebuffCli, findLatestCliConversationId } from '../pty.js';
import { assertSafeId, redact } from '../security.js';
import { BackendCapabilities, BackendEventInput, BackendSession, BackendTurnResult, BridgeError, ErrorCodes, FreebuffBackend } from '../bridge/types.js';

const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b/i;

interface PendingTurn {
  text: string;
  startedAt: number;
  outputMarker: number;
  onEvent?: (event: BackendEventInput) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * CLI PTY backend — the fallback, not the primary architecture.
 *
 * Identity safety: new sessions are created SERIALLY per project so that
 * "most recently modified chat directory" can never be misattributed between
 * concurrent runs. `--continue` only ever receives a conversation id that has
 * been verified to exist in the CLI chat store.
 */
export class CliBackend implements FreebuffBackend {
  readonly kind = 'cli' as const;
  private manager = new CliPtyManager();
  private sessions = new Map<string, BackendSession & { conversationId?: string; pid: number; output: string; exited: boolean; startedAt: number }>();
  private createLocks = new Map<string, Promise<BackendSession>>();
  private pending = new Map<string, PendingTurn>();

  constructor(private projectRoot: string = process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd()) {}

  private projectKey(cwd: string): string {
    return `${path.basename(cwd)}--${createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12)}`;
  }

  async probe(): Promise<BackendCapabilities> {
    const cli = await findFreebuffCli();
    return {
      backend: 'cli',
      connection: cli ? 'cli_ready' : 'cli_not_authenticated',
      authorization: cli ? 'write_authorized' : 'none',
      liveProgress: 'unavailable',
      canCreateSession: Boolean(cli),
      canSendMessage: Boolean(cli),
      canStop: Boolean(cli),
      canResume: Boolean(cli),
      canSetModel: Boolean(cli),
      canSetReasoning: Boolean(cli),
      notes: [cli ? `Freebuff CLI found (${path.basename(cli)}); PTY fallback available.` : 'Freebuff CLI not found on PATH or FREEBUFF_CLI_PATH.'],
    };
  }

  async createSession({ cwd, continueBackendId }: { cwd: string; continueBackendId?: string }): Promise<BackendSession> {
    const key = this.projectKey(cwd);
    // Serialize session creation per project: concurrent creates would race on
    // "latest conversation" discovery and could misattribute identity.
    const existing = this.createLocks.get(key);
    const creation = (async (): Promise<BackendSession> => {
      await existing?.catch(() => undefined);
      const cli = await findFreebuffCli();
      if (!cli) throw new BridgeError(ErrorCodes.CLI_NOT_INSTALLED, 'The Freebuff CLI is not installed.', 'Install the Freebuff CLI or set FREEBUFF_CLI_PATH.');
      if (continueBackendId) {
        const verified = await this.verifyConversationId(continueBackendId, cwd);
        if (!verified) throw new BridgeError(ErrorCodes.INVALID_INPUT, `Refusing to continue: '${continueBackendId}' is not a verified Freebuff conversation id.`, 'Pass a real conversation id from list_threads, or create a new session.');
      }
      const bridgeId = randomUUID();
      const startedAt = Date.now();
      await this.manager.start(bridgeId, cwd, continueBackendId);
      // After a managed start, correlate the created conversation. Because
      // creation is serialized per project, the newest chat directory is
      // unambiguous here.
      const conversationId = continueBackendId ?? (await findLatestCliConversationId(cwd, startedAt - 1000)) ?? undefined;
      const snapshot = this.manager.snapshot(bridgeId);
      const session: BackendSession & { conversationId?: string; pid: number; output: string; exited: boolean; startedAt: number } = { id: bridgeId, backend: 'cli', ...(conversationId ? { backendSessionId: conversationId, conversationId } : {}), cwd, pid: snapshot.pid, output: '', exited: false, startedAt };
      this.sessions.set(bridgeId, session);
      return session;
    })();
    this.createLocks.set(key, creation);
    try { return await creation; } finally { if (this.createLocks.get(key) === creation) this.createLocks.delete(key); }
  }

  async verifyConversationId(id: string, cwd: string): Promise<boolean> {
    const safe = assertSafeId(id);
    const conversation = await findLatestCliConversationId(cwd, 0);
    if (conversation === safe) return true;
    // Check full history via the manager's chat-store scan.
    try {
      const { cliConversationExists } = await import('../pty.js');
      return await cliConversationExists(cwd, safe);
    } catch { return false; }
  }

  async sendMessage({ session, text, signal, onEvent }: { session: BackendSession; text: string; signal?: AbortSignal; onEvent?: (event: BackendEventInput) => void | Promise<void> }): Promise<BackendTurnResult> {
    if (!text || text.length > 100_000) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Message must be 1 to 100000 characters.');
    const state = this.sessions.get(session.id);
    const conversationId = state?.backendSessionId;
    const startedAt = Date.now();
    const turnKey = session.id;
    const outputBefore = this.manager.snapshot(session.id).output.length;
    this.pending.set(turnKey, { text, startedAt, outputMarker: outputBefore, onEvent, signal });
    try {
      const snapshot = await this.manager.send(session.id, text, session.cwd, conversationId);
      // Emit coarse progress events derived from PTY output deltas.
      const output = snapshot.output.slice(outputBefore);
      this.emitPtyProgress(session, output, onEvent);
      const exited = snapshot.exited;
      return {
        ...(conversationId ? { backendTurnId: conversationId } : {}),
        state: exited ? 'failed' : 'completed',
        result: redact({ output: output.slice(-20_000), conversationId: snapshot.conversationId, pid: snapshot.pid, ...(exited ? { exitCode: snapshot.exitCode } : {}) }),
        ...(exited ? { error: `Freebuff CLI exited with code ${snapshot.exitCode ?? 'unknown'}.` } : {}),
      };
    } finally {
      this.pending.delete(turnKey);
    }
  }

  private emitPtyProgress(session: BackendSession, output: string, onEvent?: (event: BackendEventInput) => void | Promise<void>): void {
    if (!onEvent) return;
    const lines = output.split('\n').filter((line) => line.trim() && !/^[│├└─\s]+$/.test(line));
    for (const line of lines.slice(-20)) {
      const testRun = TEST_COMMAND.test(line);
      void onEvent({
        threadId: session.backendSessionId,
        type: /running|executing|command/i.test(line) ? 'command_started' : 'phase',
        phase: testRun ? 'running_tests' : 'running_command',
        message: line.slice(0, 500),
      });
    }
  }

  async stop(session: BackendSession): Promise<void> {
    const snapshot = this.manager.stop(session.id);
    // Verify cancellation: give the child a moment, then terminate if stuck.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = this.manager.snapshot(session.id);
    if (!after.exited) {
      this.manager.kill(session.id);
    }
    void snapshot;
  }

  async resume(session: BackendSession): Promise<BackendTurnResult> {
    const conversationId = session.backendSessionId;
    if (!conversationId) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Cannot resume: no verified conversation id for this session.');
    const snapshot = await this.manager.send(session.id, '/resume', session.cwd, conversationId);
    return { backendTurnId: conversationId, state: snapshot.exited ? 'failed' : 'completed', result: redact({ output: snapshot.output.slice(-20_000) }) };
  }

  /**
   * Model and reasoning effort are set through the harness slash commands, the
   * same mechanism `resume` uses. These are advertised via `canSetModel` /
   * `canSetReasoning`, so they must exist rather than being claimed.
   */
  async setModel(session: BackendSession, model: string, _harnessId = 'codebuff'): Promise<unknown> {
    if (!model || model.length > 200) throw new BridgeError(ErrorCodes.INVALID_INPUT, 'Invalid model.');
    const snapshot = await this.manager.send(session.id, `/model ${model}`, session.cwd, session.backendSessionId);
    if (snapshot.exited) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'The Freebuff CLI exited before the model could be set.');
    return redact({ model, output: snapshot.output.slice(-4_000) });
  }

  async setReasoning(session: BackendSession, effort: string | null): Promise<unknown> {
    const snapshot = await this.manager.send(session.id, `/reasoning ${effort ?? ''}`.trimEnd(), session.cwd, session.backendSessionId);
    if (snapshot.exited) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, 'The Freebuff CLI exited before the reasoning effort could be set.');
    return redact({ effort, output: snapshot.output.slice(-4_000) });
  }

  listThreads(): Promise<unknown> { return this.manager.listConversations(this.projectRoot); }

  snapshot(sessionId: string): { id: string; conversationId?: string; pid: number; output: string; exited: boolean; exitCode?: number } {
    return this.manager.snapshot(sessionId);
  }

  dispose(): void {
    this.manager.dispose();
    this.sessions.clear();
  }
}

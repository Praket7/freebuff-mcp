import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { CliPtyManager, findFreebuffCli, findLatestCliConversationId, readCliConversationMessages, readCliConversationSnapshot, readCliRunState, readCliTurnMarkers, cliTurnStateString, findChatDir, waitForCliTurnEnd, type CliTurnMarkers } from '../pty.js';
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
    // A missing binary is "not installed", not "not authenticated": conflating
    // the two sends users down the wrong recovery path. Authentication itself
    // is only proven when a PTY session actually starts.
    if (!cli) {
      return {
        backend: 'cli',
        connection: 'not_installed',
        authorization: 'none',
        liveProgress: 'unavailable',
        canCreateSession: false,
        canSendMessage: false,
        canStop: false,
        canResume: false,
        canSetModel: false,
        canSetReasoning: false,
        notes: ['Freebuff CLI not found on PATH or FREEBUFF_CLI_PATH.'],
      };
    }
    return {
      backend: 'cli',
      connection: 'cli_ready',
      authorization: 'write_authorized',
      liveProgress: 'unavailable',
      canCreateSession: true,
      canSendMessage: true,
      canStop: true,
      canResume: true,
      canSetModel: true,
      canSetReasoning: true,
      notes: [`Freebuff CLI found (${path.basename(cli)}); PTY fallback available. Authentication is verified when a session starts.`],
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
      if (conversationId) this.registerConversationRoot(conversationId, cwd);
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
    // A session created through the composite carries its own handle; if it is
    // not a live PTY key (an existing conversation continued via a fresh PTY),
    // the verified conversation id must still reach the harness.
    const conversationId = state?.backendSessionId ?? session.backendSessionId;
    const startedAt = Date.now();
    const turnKey = session.id;
    let outputBefore = 0;
    try { outputBefore = this.manager.snapshot(session.id).output.length; } catch { /* not a running PTY yet */ }
    // Markers BEFORE submission: completion requires a post-submit terminal
    // transition, never a stale idle state or a pre-existing message.
    const baseline: CliTurnMarkers = conversationId
      ? await readCliTurnMarkers(session.cwd, conversationId).catch(() => ({ messageCount: 0, runStateMtimeMs: 0, logBytes: 0 }))
      : { messageCount: 0, runStateMtimeMs: 0, logBytes: 0 };
    this.pending.set(turnKey, { text, startedAt, outputMarker: outputBefore, onEvent, signal });
    try {
      const snapshot = await this.manager.send(session.id, text, session.cwd, conversationId);
      const activeConvId = conversationId ?? snapshot.conversationId;
      // No conversation id means no completion proof is possible: report
      // unconfirmed, never completed.
      const turnEnd = activeConvId
        ? await waitForCliTurnEnd(session.cwd, activeConvId, baseline, signal)
        : { state: 'waiting_for_user' as const, proven: false, error: 'The CLI turn outcome is unconfirmed: no conversation id was observed after submission.' };
      // Emit coarse progress events derived from PTY output deltas.
      const output = snapshot.output.slice(outputBefore);
      this.emitPtyProgress(session, output, onEvent);
      const exited = snapshot.exited;
      const finalState = exited ? 'failed' : turnEnd.state;
      return {
        ...(activeConvId ? { backendTurnId: activeConvId } : {}),
        state: finalState,
        result: redact({ output: output.slice(-20_000), conversationId: activeConvId, pid: snapshot.pid, completionProven: turnEnd.proven, ...(exited ? { exitCode: snapshot.exitCode } : {}) }),
        ...(exited ? { error: `Freebuff CLI exited with code ${snapshot.exitCode ?? 'unknown'}.` } : turnEnd.error ? { error: turnEnd.error } : {}),
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
    // A registered CLI conversation may not be a live PTY (it was continued
    // through a fresh process, or is only known from the chat store). There is
    // nothing to stop then — but a live one must be interrupted for real.
    try { this.manager.stop(session.id); } catch { return; }
    const state = this.sessions.get(session.id);
    const conversationId = session.backendSessionId ?? state?.conversationId;
    // Confirm the TURN went idle via the chat store. A successfully cancelled
    // interactive CLI stays alive, so the process being alive proves nothing —
    // and hard-killing a healthy session just because it is alive destroys it.
    if (conversationId && await this.pollCliTurnIdle(session.cwd, conversationId, 5_000)) return;
    // Cancellation could not be confirmed: give the child a brief moment, then
    // terminate the stuck process tree as a last resort.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let after: { exited: boolean } | undefined;
    try { after = this.manager.snapshot(session.id); } catch { return; }
    if (!after.exited) {
      this.manager.kill(session.id);
    }
  }

  /** Poll the chat store until the conversation's turn leaves an active state. */
  private async pollCliTurnIdle(cwd: string, conversationId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const dir = await findChatDir(cwd, conversationId).catch(() => null);
      if (dir) {
        const turnState = cliTurnStateString(await readCliRunState(dir))?.toLowerCase();
        if (turnState && !['running', 'active', 'busy', 'working', 'thinking'].includes(turnState)) return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
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

  /** Conversation id -> project root that owns it, so reads route to the right chat store. */
  private readonly conversationRoots = new Map<string, string>();

  /**
   * Record which project root owns a conversation. Sessions created through
   * this backend register themselves; the composite registers conversations it
   * resolves to the CLI so reads for another `cwd` never hit the wrong store.
   */
  registerConversationRoot(conversationId: string, cwd: string): void {
    try { this.conversationRoots.set(assertSafeId(conversationId), cwd); } catch { /* invalid ids never route */ }
    if (this.conversationRoots.size > 5_000) {
      const oldest = this.conversationRoots.keys().next();
      if (!oldest.done) this.conversationRoots.delete(oldest.value);
    }
  }

  /** Candidate chat-store roots for a conversation: its owner first, then the default. */
  private rootsFor(conversationId: string): string[] {
    const owned = this.conversationRoots.get(conversationId);
    return owned && owned !== this.projectRoot ? [owned, this.projectRoot] : [this.projectRoot];
  }

  listThreads(): Promise<unknown> { return this.manager.listConversations(this.projectRoot); }

  /** The CLI works out of a single project root; report it without inventing others. */
  listProjects(): Promise<unknown> {
    return Promise.resolve([{ id: this.projectRoot, path: this.projectRoot, name: path.basename(this.projectRoot) }]);
  }

  /** Read one conversation's summary from the CLI chat store — never a guess. */
  async getThread(backendSessionId: string): Promise<unknown> {
    const safe = assertSafeId(backendSessionId);
    for (const root of this.rootsFor(safe)) {
      const snapshot = await readCliConversationSnapshot(root, safe);
      if (Object.keys(snapshot).length) return snapshot;
    }
    throw new BridgeError(ErrorCodes.CLI_SESSION_NOT_FOUND, `No Freebuff CLI conversation '${backendSessionId}' was found in the chat store.`, 'List conversations with list_threads, then pass a real conversation id.');
  }

  /** Read the stored message log for one conversation. */
  async getMessages(backendSessionId: string): Promise<unknown> {
    const safe = assertSafeId(backendSessionId);
    for (const root of this.rootsFor(safe)) {
      const messages = await readCliConversationMessages(root, safe);
      if (messages.length) return messages;
    }
    return [];
  }

  /** The CLI chat store exposes no attachment listing. */
  listAttachments(): Promise<unknown> { return Promise.resolve([]); }

  snapshot(sessionId: string): { id: string; conversationId?: string; pid: number; output: string; exited: boolean; exitCode?: number } {
    return this.manager.snapshot(sessionId);
  }

  dispose(): void {
    this.manager.dispose();
    this.sessions.clear();
  }
}

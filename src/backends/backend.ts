import { BackendCapabilities, BackendSession, BackendStreamHealth, BackendTurnResult, BridgeError, ErrorCodes, FreebuffBackend, BackendEventInput } from '../bridge/types.js';
import { DesktopBackend } from './desktop-backend.js';
import { CliBackend } from './cli-backend.js';
import { findFreebuffCli, cliConversationExists } from '../pty.js';
import { redact, sanitizeFreebuff } from '../security.js';
import { Json } from '../types.js';

export type SelectedBackendKind = 'desktop' | 'cli';

/** What a backend is being asked to do, so a selection can answer honestly. */
export type BackendOperation =
  | 'createSession'
  | 'sendMessage'
  | 'stop'
  | 'resume'
  | 'setModel'
  | 'setReasoning'
  | 'read';

const WRITE_OPERATIONS: ReadonlySet<BackendOperation> = new Set(['sendMessage', 'stop', 'resume', 'setModel', 'setReasoning']);

/**
 * Deterministic backend selection:
 * 1. explicit CLI mode (FREEBUFF_MCP_CLI_MODE=pty) -> CLI backend
 * 2. authorized Desktop backend
 * 3. CLI fallback when the CLI exists
 * 4. unavailable (diagnostic-only state)
 *
 * A port existing is never sufficient: the Desktop backend must answer
 * /api/projects with a well-formed payload, and writes require the launch-ID
 * health check to pass.
 */
export class CompositeBackend implements FreebuffBackend {
  readonly kind = 'desktop' as const; // primary kind reported through capabilities
  readonly desktop: DesktopBackend;
  readonly cli: CliBackend;
  private forced: 'cli' | undefined;
  private desktopCaps?: BackendCapabilities;
  private cliAvailable?: boolean;
  private probedAt = 0;
  private sessions = new Map<string, { backend: FreebuffBackend; session: BackendSession }>();

  constructor(options: { projectRoot?: string; desktop?: DesktopBackend; cli?: CliBackend } = {}) {
    this.desktop = options.desktop ?? new DesktopBackend();
    this.cli = options.cli ?? new CliBackend(options.projectRoot);
    if (process.env.FREEBUFF_MCP_CLI_MODE === 'pty') this.forced = 'cli';
  }

  private async refreshProbe(): Promise<void> {
    if (this.desktopCaps && Date.now() - this.probedAt < 3_000) return;
    const [desktopCaps, cli] = await Promise.all([this.desktop.probe().catch(() => null), findFreebuffCli()]);
    this.desktopCaps = desktopCaps ?? undefined;
    this.cliAvailable = Boolean(cli);
    this.probedAt = Date.now();
  }

  private async selected(): Promise<'desktop' | 'cli'> {
    return this.selectFor('sendMessage');
  }

  /**
   * Operation-aware backend selection. A read-only Desktop can still serve
   * reads but cannot create threads or take writes, so those operations must
   * fall through to the CLI instead of being denied or (worse) routed to a
   * backend that cannot do them. Structured failures carry the recovery hint
   * instead of a bare TypeError.
   */
  private async selectFor(operation: BackendOperation): Promise<'desktop' | 'cli'> {
    if (this.forced) return 'cli';
    await this.refreshProbe();
    const desktopWritable = this.desktopCaps?.connection === 'connected_writable';
    const desktopReadable = this.desktopCaps?.connection === 'connected_read_only';
    const desktopConnected = desktopWritable || desktopReadable;
    if (operation === 'read') {
      if (desktopConnected) return 'desktop';
      if (this.cliAvailable) return 'cli';
      throw new BridgeError(ErrorCodes.NOT_INSTALLED, 'No Freebuff Desktop or CLI installation was detected.', 'Install Freebuff Desktop or the Freebuff CLI, then run freebuff-mcp doctor.');
    }
    if (desktopWritable) return 'desktop';
    if (this.cliAvailable) return 'cli';
    if (desktopReadable) {
      throw new BridgeError(ErrorCodes.DESKTOP_AUTH_REQUIRED, 'Freebuff Desktop write authorization is unavailable and no Freebuff CLI fallback was detected.', 'Restart Freebuff Desktop or reopen the project so it can issue a fresh launch authorization, then retry.');
    }
    throw new BridgeError(ErrorCodes.NOT_INSTALLED, 'No Freebuff Desktop or CLI installation was detected.', 'Install Freebuff Desktop or the Freebuff CLI, then run freebuff-mcp doctor.');
  }

  async probe(): Promise<BackendCapabilities> {
    if (this.forced) return this.cli.probe();
    await this.refreshProbe();
    const desktopCaps = this.desktopCaps;
    const cliCaps = await this.cli.probe().catch(() => null);
    if (desktopCaps && (desktopCaps.connection === 'connected_writable' || desktopCaps.connection === 'connected_read_only')) {
      // Aggregate capabilities according to the same operation-aware policy
      // used by selectFor(). A read-only Desktop still allows reads; writes
      // fall through to CLI when available.
      const writable = desktopCaps.connection === 'connected_writable';
      const merged: BackendCapabilities = {
        backend: 'desktop',
        connection: desktopCaps.connection,
        authorization: desktopCaps.authorization,
        liveProgress: desktopCaps.liveProgress,
        lastEventAt: desktopCaps.lastEventAt,
        canCreateSession: writable || (cliCaps?.canCreateSession ?? false),
        canSendMessage: writable || (cliCaps?.canSendMessage ?? false),
        canStop: writable || (cliCaps?.canStop ?? false),
        canResume: writable || (cliCaps?.canResume ?? false),
        canSetModel: writable || (cliCaps?.canSetModel ?? false),
        canSetReasoning: writable || (cliCaps?.canSetReasoning ?? false),
        notes: [...desktopCaps.notes, ...(cliCaps ? cliCaps.notes : [])].filter(Boolean),
      };
      // If Desktop is read-only but CLI is available, note the fallback
      if (!writable && cliCaps) {
        merged.notes.push('Write operations fall back to CLI (Desktop read-only).');
      }
      return merged;
    }
    if (cliCaps) return cliCaps;
    return { backend: 'desktop', connection: 'unavailable', authorization: 'none', liveProgress: 'unavailable', canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: ['No Freebuff backend is available.'] };
  }

  private backendFor(kind: 'desktop' | 'cli'): FreebuffBackend {
    return kind === 'desktop' ? this.desktop : this.cli;
  }

  async createSession(options: { cwd: string; continueBackendId?: string }): Promise<BackendSession> {
    const kind = await this.selectFor('createSession');
    const backend = this.backendFor(kind);
    // Never assert: a backend that cannot create sessions must fail with a
    // structured, actionable error instead of a TypeError.
    if (typeof backend.createSession !== 'function') {
      throw new BridgeError(
        ErrorCodes.BACKEND_UNAVAILABLE,
        `The ${kind} backend cannot create new sessions.`,
        'Pass an existing threadId to run_turn/start_thread, or set FREEBUFF_MCP_CLI_MODE=pty to create CLI sessions.',
      );
    }
    const session = await backend.createSession(options);
    if (session.backend === 'cli' && session.backendSessionId) {
      // Duck-typed: test doubles and older CLI-likes may not implement it.
      (this.cli as unknown as { registerConversationRoot?: (id: string, cwd: string) => void }).registerConversationRoot?.(session.backendSessionId, options.cwd);
    }
    this.rememberSession(session, backend);
    return session;
  }

  /** Maximum routed sessions retained; long-lived processes must not accumulate them. */
  private static readonly MAX_ROUTED_SESSIONS = 5_000;

  private rememberSession(session: BackendSession, backend: FreebuffBackend): void {
    this.sessions.set(session.id, { backend, session });
    while (this.sessions.size > CompositeBackend.MAX_ROUTED_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
  }

  /**
   * Wrap an existing real backend identity (never a bridge-generated guess) by
   * its own handle: Desktop thread id or CLI conversation id. CLI identities
   * also register their owning project root so later reads route to the right
   * chat store instead of the CLI backend's constructor root.
   */
  useExisting(kind: 'desktop' | 'cli', backendSessionId: string, cwd: string): BackendSession {
    const session: BackendSession = { id: backendSessionId, backend: kind, backendSessionId, cwd };
    if (kind === 'cli') {
      (this.cli as unknown as { registerConversationRoot?: (id: string, cwd: string) => void }).registerConversationRoot?.(backendSessionId, cwd);
    }
    this.rememberSession(session, this.backendFor(kind));
    return session;
  }

  /**
   * Resolve who owns an existing identity without guessing: a conversation id
   * present in the CLI chat store belongs to the CLI; everything else is a
   * Desktop thread id. Registration is by the real handle, so subsequent turns
   * route to the exact owner.
   */
  async resolveExisting(backendSessionId: string, cwd: string): Promise<BackendSession> {
    const isCliConversation = await cliConversationExists(cwd, backendSessionId).catch(() => false);
    return isCliConversation ? this.useExisting('cli', backendSessionId, cwd) : this.useExisting('desktop', backendSessionId, cwd);
  }

  async sendMessage(options: { session: BackendSession; text: string; signal?: AbortSignal; onEvent?: (event: BackendEventInput) => void | Promise<void> }): Promise<BackendTurnResult> {
    const entry = this.sessions.get(options.session.id);
    const backend = entry?.backend ?? await this.pickForSession(options.session);
    return backend.sendMessage(options);
  }

  private async pickForSession(session: BackendSession): Promise<FreebuffBackend> {
    const kind = session.backend === 'cli' ? 'cli' : 'desktop';
    if (kind === 'cli') return this.cli;
    const caps = await this.probe();
    if (caps.connection !== 'connected_writable' && caps.connection !== 'connected_read_only') throw new BridgeError(ErrorCodes.DESKTOP_NOT_FOUND, 'Freebuff Desktop is not connected.');
    return this.desktop;
  }

  async stop(session: BackendSession): Promise<void> {
    const entry = this.sessions.get(session.id);
    const backend = entry?.backend ?? await this.pickForSession(session);
    if (!backend.stop) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, `The ${backend.kind} backend cannot stop turns.`);
    await backend.stop(session);
  }

  /** Route model/reasoning changes to the backend that owns the session. */
  async setModel(session: BackendSession, model: string, harnessId = 'codebuff'): Promise<unknown> {
    const backend = this.sessions.get(session.id)?.backend ?? await this.pickForSession(session);
    if (!backend.setModel) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, `The ${backend.kind} backend cannot change models.`);
    return backend.setModel(session, model, harnessId);
  }

  async setReasoning(session: BackendSession, effort: string | null): Promise<unknown> {
    const backend = this.sessions.get(session.id)?.backend ?? await this.pickForSession(session);
    if (!backend.setReasoning) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, `The ${backend.kind} backend cannot change reasoning effort.`);
    return backend.setReasoning(session, effort);
  }

  /**
   * Aggregate reads route to whichever backend can actually serve them: the
   * Desktop when it is connected (even read-only), otherwise the CLI's chat
   * store. Never a hardcoded Desktop call — that is how a read-only or absent
   * Desktop silently emptied thread listings.
   */
  async listProjects(): Promise<Json> { return sanitizeFreebuff(await this.readVia('listProjects', () => [])) as Json; }
  async listThreads(): Promise<Json> { return sanitizeFreebuff(await this.readVia('listThreads', () => [])) as Json; }

  /** Return a backend already known to own this real thread/conversation id. */
  private rememberedBackendForId(backendSessionId: string): FreebuffBackend | undefined {
    for (const entry of this.sessions.values()) {
      if (entry.session.id === backendSessionId || entry.session.backendSessionId === backendSessionId) return entry.backend;
    }
    return undefined;
  }

  /**
   * Resolve direct reads by identity, not by the globally preferred read backend.
   * A connected Desktop must not steal reads for a real CLI conversation id.
   * CLI ownership is proven by its chat store; otherwise a connected Desktop
   * remains the fallback owner.
   */
  private async backendForReadId(backendSessionId: string): Promise<FreebuffBackend> {
    const remembered = this.rememberedBackendForId(backendSessionId);
    if (remembered) return remembered;
    if (this.forced) return this.cli;
    await this.refreshProbe();
    const cwd = process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd();
    const isCliConversation = this.cliAvailable
      ? await cliConversationExists(cwd, backendSessionId).catch(() => false)
      : false;
    if (isCliConversation) return this.cli;
    const connection = this.desktopCaps?.connection;
    if (connection === 'connected_writable' || connection === 'connected_read_only') return this.desktop;
    if (this.cliAvailable) return this.cli;
    throw new BridgeError(ErrorCodes.NOT_INSTALLED, 'No Freebuff backend is available to read this thread.', 'Start Freebuff Desktop or install the Freebuff CLI, then retry.');
  }

  async getThread(backendSessionId: string): Promise<Json> {
    const backend = await this.backendForReadId(backendSessionId);
    if (!backend.getThread) throw new BridgeError(ErrorCodes.BACKEND_UNAVAILABLE, `The ${backend.kind} backend cannot read threads.`);
    return sanitizeFreebuff(await backend.getThread(backendSessionId)) as Json;
  }

  async getMessages(backendSessionId: string): Promise<Json> {
    const backend = await this.backendForReadId(backendSessionId);
    if (!backend.getMessages) return [] as Json;
    return sanitizeFreebuff(await backend.getMessages(backendSessionId)) as Json;
  }

  private async readVia(method: 'listProjects' | 'listThreads', whenMissing: () => unknown, ...args: string[]): Promise<unknown> {
    const kind = await this.selectFor('read');
    const backend = this.backendFor(kind);
    const fn = (backend as unknown as Record<string, unknown>)[method] as ((...a: string[]) => Promise<unknown>) | undefined;
    if (typeof fn !== 'function') return whenMissing();
    return await fn(...args);
  }

  /**
   * Stream health belongs to the backend that actually holds a stream: the
   * Desktop (persistent SSE) or the CLI when it is explicitly forced. The CLI
   * has no persistent stream, so it reports nothing and the canonical layer
   * falls back to turn-scoped liveness.
   */
  onStreamHealth(listener: (health: BackendStreamHealth) => void): () => void {
    const backend: FreebuffBackend = this.forced === 'cli' ? this.cli : this.desktop;
    return backend.onStreamHealth?.(listener) ?? (() => undefined);
  }

  dispose(): void {
    this.desktop.dispose();
    this.cli.dispose();
  }
}

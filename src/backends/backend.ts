import { randomUUID } from 'node:crypto';
import { BackendCapabilities, BackendSession, BackendStreamHealth, BackendTurnResult, BridgeError, ErrorCodes, FreebuffBackend, BackendEventInput } from '../bridge/types.js';
import { DesktopBackend } from './desktop-backend.js';
import { CliBackend } from './cli-backend.js';
import { findFreebuffCli } from '../pty.js';
import { redact, sanitizeFreebuff } from '../security.js';
import { Json } from '../types.js';

export type SelectedBackendKind = 'desktop' | 'cli';

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
    if (this.forced) return 'cli';
    await this.refreshProbe();
    const desktopWritable = this.desktopCaps?.connection === 'connected_writable';
    const desktopReadable = this.desktopCaps?.connection === 'connected_read_only';
    if ((desktopWritable || desktopReadable) && this.cliAvailable) return 'desktop';
    if (desktopWritable || desktopReadable) return 'desktop';
    if (this.cliAvailable) return 'cli';
    throw new BridgeError(ErrorCodes.NOT_INSTALLED, 'No Freebuff Desktop or CLI installation was detected.', 'Install Freebuff Desktop or the Freebuff CLI, then run freebuff-mcp doctor.');
  }

  async probe(): Promise<BackendCapabilities> {
    if (this.forced) return this.cli.probe();
    await this.refreshProbe();
    const desktopCaps = this.desktopCaps;
    const cliCaps = await this.cli.probe().catch(() => null);
    if (desktopCaps && (desktopCaps.connection === 'connected_writable' || desktopCaps.connection === 'connected_read_only')) {
      return { ...desktopCaps, canCreateSession: true, notes: [...desktopCaps.notes, ...(cliCaps ? [cliCaps.notes[0] ?? ''] : []).filter(Boolean)] };
    }
    if (cliCaps) return cliCaps;
    return { backend: 'desktop', connection: 'unavailable', authorization: 'none', liveProgress: 'unavailable', canCreateSession: false, canSendMessage: false, canStop: false, canResume: false, canSetModel: false, canSetReasoning: false, notes: ['No Freebuff backend is available.'] };
  }

  private backendFor(kind: 'desktop' | 'cli'): FreebuffBackend {
    return kind === 'desktop' ? this.desktop : this.cli;
  }

  async createSession(options: { cwd: string; continueBackendId?: string }): Promise<BackendSession> {
    const kind = await this.selected();
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
    this.sessions.set(session.id, { backend, session });
    return session;
  }

  /** Wrap an existing real backend identity (never a bridge-generated guess). */
  useExisting(kind: 'desktop' | 'cli', backendSessionId: string, cwd: string): BackendSession {
    const session: BackendSession = { id: randomUUID(), backend: kind, backendSessionId, cwd };
    this.sessions.set(session.id, { backend: this.backendFor(kind), session });
    return session;
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

  async listProjects(): Promise<Json> { return sanitizeFreebuff(await this.desktop.listProjects()) as Json; }
  async listThreads(): Promise<Json> { return sanitizeFreebuff(await this.desktop.listThreads()) as Json; }
  async getThread(backendSessionId: string): Promise<Json> { return sanitizeFreebuff(await this.desktop.getThread(backendSessionId)) as Json; }
  async getMessages(backendSessionId: string): Promise<Json> { return sanitizeFreebuff(await this.desktop.getMessages(backendSessionId)) as Json; }

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

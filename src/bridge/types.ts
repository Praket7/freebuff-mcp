// Canonical bridge data model shared by every protocol adapter (MCP v2, legacy
// MCP, ACP) and every backend adapter (Desktop, CLI PTY).
//
// Identity rules (never violate):
// - BridgeSession.id and BridgeTurn.id are bridge-generated identities.
// - backendSessionId / backendTurnId hold the REAL Freebuff identity (for
//   example the Desktop thread id or the CLI conversation id). They are never
//   assumed to equal the bridge id, and bridge ids are never passed to Freebuff
//   as conversation ids unless they have been verified to be real ones.
// - Both are set only when Freebuff actually supplies one. A backend that
//   returns no turn identity (the Desktop acknowledges a submission with
//   `{ ok, queued }` and nothing more) leaves backendTurnId unset rather than
//   inventing one.

export type BackendKind = 'desktop' | 'cli' | 'sdk';

export type BridgeSessionState =
  | 'ready'
  | 'running'
  | 'waiting_for_user'
  | 'closed'
  | 'failed';

export interface BridgeSession {
  id: string;
  backend: BackendKind;
  /** Real Freebuff identity (Desktop thread id or CLI conversation id). */
  backendSessionId?: string;
  /**
   * The exact handle the owning backend addresses this session by — the value
   * it returned as its own `BackendSession.id` (the CLI PTY key, or the Desktop
   * thread id). Never a bridge-generated UUID: routing a turn through this
   * handle is what keeps every prompt/cancel/model change on the real owner.
   */
  backendHandleId?: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  state: BridgeSessionState;
  activeTurnId?: string;
}

export type BridgeTurnState =
  | 'queued'
  | 'running'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export function isTerminalTurnState(state: BridgeTurnState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export interface BridgeTurn {
  id: string;
  sessionId: string;
  backendTurnId?: string;
  state: BridgeTurnState;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Highest event sequence emitted for this turn. */
  lastSequence: number;
  result?: unknown;
  error?: string;
}

export type BridgeEventType =
  | 'queued'
  | 'turn_started'
  | 'phase'
  | 'assistant_delta'
  | 'assistant_message'
  | 'tool_started'
  | 'tool_finished'
  | 'file_changed'
  | 'command_started'
  | 'command_finished'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'connection_state'
  | 'unknown';

export type BridgePhase =
  | 'planning'
  | 'reading_files'
  | 'editing_files'
  | 'running_command'
  | 'running_tests'
  | 'reviewing'
  | 'waiting_for_input'
  | 'completed'
  | 'failed';

export interface BridgeEvent {
  sequence: number;
  upstreamEventId?: string;
  sessionId: string;
  turnId: string;
  threadId: string;
  timestamp: string;
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

// ---------------------------------------------------------------------------
// Structured error model
// ---------------------------------------------------------------------------

export const ErrorCodes = {
  NOT_INSTALLED: 'FREEBUFF_NOT_INSTALLED',
  NOT_RUNNING: 'FREEBUFF_NOT_RUNNING',
  CLI_NOT_INSTALLED: 'FREEBUFF_CLI_NOT_INSTALLED',
  CLI_NOT_AUTHENTICATED: 'FREEBUFF_CLI_NOT_AUTHENTICATED',
  CLI_ALREADY_RUNNING: 'FREEBUFF_CLI_ALREADY_RUNNING',
  CLI_SESSION_LIMIT: 'FREEBUFF_CLI_SESSION_LIMIT',
  CLI_SESSION_EXITED: 'FREEBUFF_CLI_SESSION_EXITED',
  CLI_SESSION_NOT_FOUND: 'FREEBUFF_CLI_SESSION_NOT_FOUND',
  DESKTOP_NOT_FOUND: 'FREEBUFF_DESKTOP_NOT_FOUND',
  DESKTOP_AUTH_REQUIRED: 'FREEBUFF_DESKTOP_AUTH_REQUIRED',
  DESKTOP_API_INCOMPATIBLE: 'FREEBUFF_DESKTOP_API_INCOMPATIBLE',
  DESKTOP_EVENT_STREAM_UNAVAILABLE: 'FREEBUFF_DESKTOP_EVENT_STREAM_UNAVAILABLE',
  DESKTOP_HANDOFF_INVALID: 'FREEBUFF_DESKTOP_HANDOFF_INVALID',
  SESSION_NOT_FOUND: 'FREEBUFF_SESSION_NOT_FOUND',
  TURN_NOT_FOUND: 'FREEBUFF_TURN_NOT_FOUND',
  TURN_ALREADY_ACTIVE: 'FREEBUFF_TURN_ALREADY_ACTIVE',
  BACKEND_UNAVAILABLE: 'FREEBUFF_BACKEND_UNAVAILABLE',
  OPERATION_CANCELLED: 'FREEBUFF_OPERATION_CANCELLED',
  OPERATION_TIMEOUT: 'FREEBUFF_OPERATION_TIMEOUT',
  PTY_LAUNCH_FAILED: 'FREEBUFF_PTY_LAUNCH_FAILED',
  INVALID_INPUT: 'FREEBUFF_INVALID_INPUT',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface BridgeErrorShape {
  ok: false;
  code: ErrorCode;
  message: string;
  recovery?: string;
}

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly recovery?: string;
  constructor(code: ErrorCode, message: string, recovery?: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.recovery = recovery;
  }
  toShape(): BridgeErrorShape {
    return { ok: false as const, code: this.code, message: this.message, ...(this.recovery ? { recovery: this.recovery } : {}) };
  }
}

export function isBridgeError(error: unknown): error is BridgeError {
  return error instanceof BridgeError;
}

/** Convert any thrown value into a structured, secret-free error payload. */
export function toErrorShape(error: unknown): BridgeErrorShape {
  if (isBridgeError(error)) return error.toShape();
  const message = error instanceof Error ? error.message : String(error);
  if (/Not authenticated|Press ENTER to login/i.test(message)) return new BridgeError(ErrorCodes.CLI_NOT_AUTHENTICATED, 'The Freebuff CLI is not authenticated.', 'Run the Freebuff CLI once and sign in, then retry.').toShape();
  if (/already running/i.test(message)) return new BridgeError(ErrorCodes.CLI_ALREADY_RUNNING, 'Freebuff CLI is already running in this project.', 'Close the other Freebuff CLI session or set FREEBUFF_CLI_TAKEOVER=1, then retry.').toShape();
  if (/launch failed|posix_spawnp/i.test(message)) return new BridgeError(ErrorCodes.PTY_LAUNCH_FAILED, message, 'Verify the Freebuff CLI is installed and executable; see freebuff-mcp doctor.').toShape();
  return { ok: false as const, code: ErrorCodes.BACKEND_UNAVAILABLE, message };
}

// ---------------------------------------------------------------------------
// Backend capability model
// ---------------------------------------------------------------------------

export type ConnectionTruth =
  | 'not_installed'
  | 'not_running'
  | 'discovering'
  | 'connected_read_only'
  | 'connected_writable'
  | 'authorization_required'
  | 'event_stream_unavailable'
  | 'degraded'
  | 'cli_ready'
  | 'cli_not_authenticated'
  | 'unavailable';

export interface BackendCapabilities {
  backend: BackendKind;
  connection: ConnectionTruth;
  /**
   * Write-authorization truth. `unknown` means the backend exists but nothing
   * has proven authentication yet (a CLI binary on disk proves nothing about
   * login); only a successful authenticated operation promotes it.
   */
  authorization: 'none' | 'read_only' | 'write_authorized' | 'unknown';
  /** True only when the live event stream itself is healthy — never inferred from other API success. */
  liveProgress: 'connected' | 'stale' | 'unavailable';
  /** Timestamp of the most recent live event received, when one has arrived. */
  lastEventAt?: string;
  canCreateSession: boolean;
  canSendMessage: boolean;
  canStop: boolean;
  canResume: boolean;
  canSetModel: boolean;
  canSetReasoning: boolean;
  notes: string[];
}

export interface BackendSession {
  /** Bridge-owned id. */
  id: string;
  backend: BackendKind;
  /** Real Freebuff conversation/thread identity, when known. */
  backendSessionId?: string;
  cwd: string;
}

export interface BackendTurnResult {
  backendTurnId?: string;
  state: BridgeTurnState;
  result?: unknown;
  error?: string;
}

export interface BackendEventInput {
  backendTurnId?: string;
  threadId?: string;
  upstreamEventId?: string;
  timestamp?: string;
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

/** Live stream health, reported by backends that hold a persistent stream. */
export interface BackendStreamHealth {
  connected: boolean;
  /**
   * True when progress events may have been missed — for example while the
   * stream was down. Cleared once full state is known again.
   */
  gapSuspected?: boolean;
}

export interface FreebuffBackend {
  kind: BackendKind;
  probe(): Promise<BackendCapabilities>;
  createSession?(options: { cwd: string; continueBackendId?: string }): Promise<BackendSession>;
  sendMessage(options: {
    session: BackendSession;
    text: string;
    signal?: AbortSignal;
    onEvent?: (event: BackendEventInput) => void | Promise<void>;
  }): Promise<BackendTurnResult>;
  stop?(session: BackendSession, turnId?: string): Promise<void>;
  resume?(session: BackendSession): Promise<BackendTurnResult>;
  listProjects?(): Promise<unknown>;
  listThreads?(): Promise<unknown>;
  getThread?(backendSessionId: string): Promise<unknown>;
  getMessages?(backendSessionId: string): Promise<unknown>;
  /** True only when this backend can prove it owns the supplied real session id. */
  ownsSessionId?(backendSessionId: string): Promise<boolean>;
  /**
   * Optional live event-stream health, so adapters report progress honestly
   * instead of guessing. Backends with a persistent stream (Desktop) implement
   * this and invoke `listener` with the current value on subscribe. Backends
   * that stream only while a turn runs (CLI/PTY) omit it.
   */
  onStreamHealth?(listener: (health: BackendStreamHealth) => void): () => void;
  /**
   * Set the model for an existing backend session. Advertised through
   * `canSetModel`, so a backend that reports the capability must implement it.
   */
  setModel?(session: BackendSession, model: string, harnessId?: string): Promise<unknown>;
  /** Set the reasoning effort for an existing backend session. */
  setReasoning?(session: BackendSession, effort: string | null): Promise<unknown>;
  dispose(): Promise<void> | void;
}

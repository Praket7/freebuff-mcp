# Architecture

The bridge is organized around one canonical session/turn/event lifecycle. Protocol adapters depend on the canonical layer, never on Desktop or PTY specifics.

```text
Codex / Claude Code / ACP
        |
        v
MCP v2 (mcp-v2.ts) | legacy MCP v1 (mcp.ts) | ACP (acp.ts) | HTTP (mcp.ts runHttp)
        |
        v
Canonical bridge layer
  SessionManager (bridge/session-manager.ts)
  TurnManager    (bridge/turn-manager.ts)
  EventStore     (bridge/event-store.ts)
        |
        v
Backend selection (backends/backend.ts)
        |
        +---------------------------+
        |                           |
        v                           v
DesktopBackend                CliBackend (PTY fallback)
(backends/desktop-backend.ts) (backends/cli-backend.ts)
  discovery (desktop/)          pty helpers (pty.ts)
  SSE (desktop/sse.ts)
```

## Identity model

- `BridgeSession.id` / `BridgeTurn.id` are bridge-generated UUIDs.
- `backendSessionId` / `backendTurnId` hold the REAL Freebuff identity (Desktop thread id, CLI conversation id). They are never assumed to equal the bridge ids.
- Bridge ids are never passed to Freebuff as conversation ids. `--continue` receives only ids verified to exist in the CLI chat store; new CLI session creation is serialized per project so "latest chat directory" is unambiguous.

## Backend selection (deterministic)

1. `FREEBUFF_MCP_CLI_MODE=pty` → CLI backend
2. Desktop with verified write authorization (`/healthz` passing with the launch id)
3. Desktop read-only
4. CLI fallback (CLI binary found)
5. Structured unavailable state (`FREEBUFF_NOT_INSTALLED`)

Desktop discovery order (`desktop/discovery.ts`): handoff file → explicit `FREEBUFF_ORCHESTRATOR_URL` → readiness metadata files → running orchestrator process (macOS/Linux, current user) → log-file port hints → narrow listener fallback only when nothing else matched. Results are cached (10 s TTL) and invalidated on connection failures.

## Handoff authorization (`desktop/handoff.ts`)

The Desktop (or a fixture) writes a current-user-only JSON file:

```json
{ "version": 1, "url": "http://127.0.0.1:PORT", "launchId": "SHORT_LIVED_SECRET", "pid": 1234, "expiresAt": "ISO" }
```

Validation covers presence, JSON shape, version, loopback URL, live PID, and expiry. The launch id is then challenged over HTTP (`/healthz` with `x-freebuff-launch-id`); only a passing challenge grants write capability. No process memory is read on any platform.

## Live events (`desktop/sse.ts`, `desktop/event-adapter.ts`)

`SseClient` is a resilient SSE loop: LF/CRLF, comments, multiline `data:`, `event:`/`id:`/`retry:`, `Last-Event-ID` on reconnect, bounded backoff with 50–100% jitter, connection timeout, buffer caps, and cancellation. Untrusted payloads are mapped to structured bridge events (reasoning dropped, secrets redacted, phases classified structurally). `liveProgress: connected` reflects only the event stream's own health — never `/api/projects` success.

## Event store (`bridge/event-store.ts`)

Global monotonic sequence; per-thread bounded retention (500 events / 1 MB / 30 min TTL); per-thread (never global) staleness; terminal turn states recorded and surfaced; waiters woken per thread without lost wakeups; cursors are incremental (`afterSequence` → `nextSequence`), verified past 100 events.

## Turn lifecycle (`bridge/session-manager.ts`)

`startTurn` → `queued` → `running` → (terminal: `completed` | `failed` | `cancelled`, or `waiting_for_user`). The turn's AbortController is registered so `cancelTurn`/MCP cancellation/ACP cancel abort the backend; terminal states clear the session's active turn. One active turn per session; concurrent attempts fail with `FREEBUFF_TURN_ALREADY_ACTIVE`.

## Error model (`bridge/types.ts`)

Stable machine-readable codes (`FREEBUFF_*`), surfaced by every adapter as `{ ok:false, code, message, recovery? }`. Stack traces never reach clients; secrets are redacted.

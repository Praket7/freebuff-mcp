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

The canonical layer is the ONLY implementation: MCP v2, legacy MCP v1 (`mcp.ts`), the HTTP transport, and ACP all reach Desktop and CLI through the same discovery, SSE client, event adapter, and event store. Nothing re-implements discovery or SSE, so the legacy path cannot drift (in particular it no longer scans every localhost listener) and `liveProgress` has one definition everywhere.

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

`SseClient` is a resilient SSE loop: LF/CRLF, comments, multiline `data:`, `event:`/`id:`/`retry:`, `Last-Event-ID` on reconnect, bounded backoff with 50–100% jitter, connection timeout, buffer caps, and cancellation. Untrusted payloads are mapped to structured bridge events (reasoning dropped, secrets redacted, phases classified structurally). `liveProgress: connected` reflects only the event stream's own health — never `/api/projects` success. This holds in every adapter, including legacy MCP v1 and HTTP.

The stream has **no heartbeat**: it bursts snapshot frames on connect and then stays silent while the project is idle (measured against a live Desktop). Silence is therefore not evidence of a dead stream, and `lastEventAt` freshness must not gate `liveProgress` — only the client's own connection state may.

That same connection state is fed to the event store: the Desktop backend exposes it through the optional `onStreamHealth`, the composite backend delegates to the backend that owns the stream, and `SessionManager` subscribes so every adapter's progress snapshots report `connected`/`stale` truthfully. Backends with no persistent stream (CLI/PTY) report turn-scoped liveness instead.

## Event store (`bridge/event-store.ts`)

Global monotonic sequence; per-thread bounded retention (500 events / 1 MB / 30 min TTL); per-thread (never global) staleness; terminal turn states recorded and surfaced; waiters woken per thread without lost wakeups; cursors are incremental (`afterSequence` → `nextSequence`), verified past 100 events.

## Desktop HTTP contract (verified against a live Desktop)

The bridge speaks the routes the Desktop UI itself uses. Shapes that are easy to get wrong are pinned by fixtures in `test/desktop-wire.test.ts`:

- `GET /api/projects` → `{ projects: [{ path, threads: [...] }] }` — threads are **nested inside projects**.
- `GET /api/thread/:id` → `{ thread, messages, items }` — the thread is **wrapped**.
- `POST /api/threads` → creates a thread (returns the thread object, including its id).
- `POST /api/thread/:id/<action>` — one wildcard route; actions include `message`, `stop`, `resume`, `agent` (`{ harnessId, model }`), `effort` (`{ effort }`), `rename`, `fork`, `close`.
- `GET /api/thread/:id/changes` → `{ scope, branch, files: [{ path, adds, dels }], totals }`.
- `GET /api/thread/:id/changes/diff?file=&scope=&untracked=` → `{ patch }`, or `{ error }` / `{ tooLarge }` / `{ binary }`.
- `GET /api/events` → SSE frames `data: {"type":"state","snapshot":{ threads: [...] }}` (no `event:` field).
- Thread `turnState` is `running | idle`; a finished turn records `lastTurnOutcome` (`closed` / `error`) and `lastTurnFinishedAt`.

A turn is only reported `completed` after the Desktop stops reporting `running` (or `lastTurnFinishedAt` advances). If that cannot be confirmed within bounds the bridge returns the non-terminal `waiting_for_user` instead of claiming success.

## Turn lifecycle (`bridge/session-manager.ts`)

`startTurn` → `queued` → `running` → (terminal: `completed` | `failed` | `cancelled`, or `waiting_for_user`). The turn's AbortController is registered so `cancelTurn`/MCP cancellation/ACP cancel abort the backend; terminal states clear the session's active turn. One active turn per session; concurrent attempts fail with `FREEBUFF_TURN_ALREADY_ACTIVE`.

## Error model (`bridge/types.ts`)

Stable machine-readable codes (`FREEBUFF_*`), surfaced by every adapter as `{ ok:false, code, message, recovery? }`. Stack traces never reach clients; secrets are redacted.

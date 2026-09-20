# freebuff-mcp

A production MCP bridge for a locally installed, signed-in Freebuff Desktop or CLI installation. It gives MCP clients (Codex, Claude Code, and others) bounded access to Freebuff projects, threads, live turn progress, safe project-file reads, and full coding turns.

## Requirements

- Windows, macOS, or Linux
- Node.js 20 or newer
- Freebuff Desktop or the Freebuff CLI installed and signed in

The bridge runs entirely on your machine. It does not dump process memory, steal credentials, or expose your auth tokens. See SECURITY.md.

## What it does

- **Canonical sessions and turns.** Every interaction is a bridge session/turn with its own identity, mapped explicitly to the real Freebuff thread or conversation id. Bridge ids are never passed to Freebuff as conversation ids. MCP v2, HTTP, and ACP all run on this one implementation (`CompositeBackend + SessionManager + TurnManager`); discovery, SSE parsing, and the event store are never duplicated. The legacy `serve-v1` surface keeps its own runtime adapter for backward compatibility and is covered by its own contract tests.
- **Deterministic backend selection.** 1) Desktop with verified write authorization, 2) Desktop read-only, 3) Freebuff CLI via a managed PTY (fallback), 4) a structured unavailable state. A port being open is never enough: `/api/projects` must answer correctly and the launch-ID health check must pass for writes.
- **`run_turn` with live progress.** A first-class long-running MCP tool that streams coalesced, request-scoped progress notifications and honors MCP cancellation (`notifications/cancelled` → backend abort).
- **Resilient Desktop connection.** Handoff-file-first discovery (no broad port scanning in the normal path), SSE with `Last-Event-ID`, `retry:`, bounded backoff with jitter, and recovery from 401/403/404, 5xx, ECONNREFUSED, timeouts, and Desktop restarts/port rotation.
- **Bounded event store.** Per-thread sequences and cursors, count/byte/TTL retention, per-thread staleness, terminal states clear running state. Events past 100 are readable with `afterSequence`.
- **Accurate phases.** `read_files`/`code_search` → reading files; `change_file`/`apply_patch` → editing files; terminal commands → running a command; only actual test commands (`pnpm test`, `pytest`, `cargo test`, …) are classified as running tests.

## Install

```bash
npm install --global freebuff-mcp
freebuff-mcp doctor
```

`doctor` prints (or `--json` emits) package version, platform, selected backend, Desktop detection/authorization, event-stream state (including the timestamp of the most recent live event), CLI detection, PTY/node-pty version, handoff status, capabilities, and recent safe diagnostic errors.

## Configure Codex

```bash
freebuff-mcp install codex          # print config
freebuff-mcp install codex --write  # append to ~/.codex/config.toml (refuses to overwrite an existing entry)
```

Generated entry (note `tool_timeout_sec` — long coding turns exceed Codex's default tool timeout):

```toml
[mcp_servers.freebuff]
command = 'node'
args = ['/path/to/freebuff-mcp/dist/src/cli.js', 'serve']
startup_timeout_sec = 20
tool_timeout_sec = 3600
enabled = true
```

## Configure Claude Code

```bash
freebuff-mcp install claude            # print instructions
freebuff-mcp install claude --write    # merge into ~/.claude.json (user scope)
freebuff-mcp install claude --write --project   # write ./.mcp.json (project scope)
```

The writer merges into the `mcpServers` object, preserves unrelated keys, and refuses to clobber a differing existing `freebuff` entry. Equivalent manual command:

```bash
claude mcp add --scope user freebuff -- node /path/to/freebuff-mcp/dist/src/cli.js serve
```

## Tools (MCP v2, `freebuff-mcp serve`)

The catalog is stable: tools are always registered and return structured actionable errors (`{ ok:false, code, message, recovery }`) when Freebuff is unavailable — availability never depends on the client processing dynamic tool-list updates.

- Status/discovery: `freebuff_status`, `list_projects`, `list_threads`, `get_thread`, `get_thread_messages`, `get_active_work`, `search_history`, `list_models`
- Progress: `get_turn`, `watch_turn`, `get_thread_progress`, `watch_thread`, `get_thread_progress_summary`, `watch_active_threads`, `get_changed_files`
- Changes/diff: `get_changes` (Desktop change summary), `get_diff` (real per-file patches; reports `binary`/`tooLarge`/`error` rather than inventing a diff)
- Sessions/turns: `start_thread`, `send_message` (async, returns `turnId`), `run_turn` (synchronous with progress + cancellation), `stop_turn`, `stop_thread`, `resume_thread`, `set_model`, `set_reasoning`
- Files/attachments: `list_project_files`, `read_project_file`, `list_thread_attachments`

### `run_turn` and cancellation

`run_turn` keeps the MCP request open for the whole Freebuff turn, emits request-scoped progress notifications (coalesced, human-meaningful — never token spam), aborts the backend when the MCP client cancels the request, and returns structured output (`turnId`, `state`, `result`/`error`) when the turn is terminal.

### Resources

`freebuff://projects`, project threads, thread messages, and per-thread progress resources are available. Resource updates are throttled (max one per thread per 2 s) and are supplementary to progress tools.

## ACP (experimental)

`freebuff-mcp serve-acp` implements the ACP v1 wire contract on the canonical bridge: ACP session ids map to real Freebuff identities, prompts complete only at terminal turn state, progress uses an advancing cursor, assistant text comes only from structured deltas, and infrastructure errors are reported as errors (never "refusal"). Only implemented capabilities are advertised.

## HTTP transport (optional, local-first)

Stdio is the safer default. `freebuff-mcp serve-http` binds `127.0.0.1:8788`, requires `Authorization: Bearer $FREEBUFF_MCP_TOKEN` on `/mcp`, validates Origin, bounds request bodies, and refuses non-loopback binding unless `FREEBUFF_MCP_ALLOW_REMOTE=1`. Remote use requires trusted HTTPS/private networking.

## CLI fallback mode

Set `FREEBUFF_MCP_CLI_MODE=pty` to force the CLI backend. New-session creation is serialized per project so conversation identity is never misattributed; `--continue` only receives conversation ids verified to exist in the CLI chat store; cancellation is verified and stuck children are cleaned up. Readiness relies on multiple signals, and UI scraping stays isolated here as fallback behavior.

## Environment reference

| Variable | Purpose |
| --- | --- |
| `FREEBUFF_PROJECT_ROOT` | Project root for CLI-mode sessions |
| `FREEBUFF_MCP_CLI_MODE=pty` | Force the CLI PTY backend |
| `FREEBUFF_ORCHESTRATOR_URL` | Explicit Desktop URL (skips discovery) |
| `FREEBUFF_MCP_HANDOFF_FILE` | Explicit Desktop handoff file path |
| `FREEBUFF_CLI_PATH` | Explicit Freebuff CLI executable path |
| `FREEBUFF_MCP_TOKEN` | Bearer token for `serve-http` |

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck        # src
pnpm typecheck:test   # src + tests
pnpm test
pnpm build
pnpm pack:check
```

The suite (158 tests) covers the event store (cursors past 100 events, retention, per-thread staleness), SSE parsing/reconnect/Last-Event-ID/retry, handoff validation matrix, Desktop restart recovery, session/turn lifecycle and cancellation, phase classification, live-progress honesty, redaction classes, installers on existing/missing configs, and MCP integration tests that drive the real server through the MCP SDK client for both the v2 (`serve`) and legacy v1 (`serve-v1`) surfaces.

Because CI has no Freebuff Desktop, `test/helpers/fake-desktop.ts` serves the Desktop HTTP contract (payload shapes first captured from a live installation): `test/desktop-wire.test.ts` pins the exact payload shapes, `test/desktop-http-integration.test.ts` drives real sockets including turn completion/cancellation, and `test/http-transport.test.ts` / `test/acp-wire.test.ts` spawn the real `serve-http` and `serve-acp` processes to verify auth, rate limiting, capability advertisement, and prompt semantics on the wire.

These are contract and fault-injection tests against fixtures — they prove the bridge honors the pinned shapes and failure semantics, not that a given release passes against real software. The 0.2.0 release gate additionally requires real smoke tests outside CI: real Desktop on Windows + macOS, real CLI long-turn + cancellation runs, an ambiguous-POST run proving no duplicate prompt/thread, and long `run_turn` runs through Codex and Claude Code.

## Security

The bridge never scrapes process memory, attaches debuggers, dumps credentials, or bypasses Freebuff permission boundaries. Desktop writes require the Desktop's own launch-ID health check; the handoff file contains only a loopback URL and a short-lived launch id, lives in the current user's config directory, and is validated (version, loopback, live PID, expiry) before use. See SECURITY.md and PRIVACY.md.

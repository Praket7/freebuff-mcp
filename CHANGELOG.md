# Changelog

## 0.2.0 (unreleased)

Production rebuild around one canonical session/turn/event lifecycle shared by every adapter.

### Architecture

- Add the canonical bridge layer (`src/bridge/`): `SessionManager`, `TurnManager`, bounded `EventStore`, and shared types/error codes. Bridge ids are always distinct from real Freebuff identities, and bridge-generated ids are never passed to Freebuff as conversation ids.
- Add backend adapters (`src/backends/`): `DesktopBackend` (structured HTTP + SSE) and `CliBackend` (PTY fallback) behind one `FreebuffBackend` contract with deterministic selection (CLI mode → authorized Desktop → read-only Desktop → CLI → structured unavailable).
- Add resilient Desktop support (`src/desktop/`): validated handoff files, ordered/cached discovery that no longer scans every localhost listener in the normal path, and an SSE client with `Last-Event-ID`, `retry:`, bounded jittered backoff, connection timeouts, and buffer caps.

### MCP v2

- Rewrite the server on the canonical bridge with a stable guarded tool catalog: unavailable Freebuff now yields structured actionable errors (`{ ok:false, code, message, recovery }`) instead of disappearing tools.
- Add `run_turn` with request-scoped, coalesced progress notifications and native MCP cancellation propagation to the backend; add `start_thread`, `send_message` (async with `turnId`), `get_turn`, `watch_turn`, `stop_turn`, and `get_changed_files`.
- Throttle resource update notifications (max one per thread per 2 s).

### ACP (experimental)

- Map ACP sessions to real backend identities, wait for terminal turn state (not submission return), advance the event cursor past 100 events, emit each assistant delta exactly once, advertise only implemented capabilities, and report infrastructure failures as errors instead of model refusals.

### Reliability & correctness

- Desktop rediscovery on 401/403/404, 5xx, ECONNREFUSED, timeouts, and port rotation with bounded retries.
- `liveProgress: connected` now reflects only the event stream's own health.
- Per-thread event staleness and cursors; terminal turn states clear running state; retention bounded by count, bytes, and TTL.
- Progress phases are classified structurally (`read_files`→reading, `apply_patch`→editing, terminal commands→running a command) and only actual test commands are labeled `running_tests`.
- CLI PTY: serialize new-session creation per project, verify conversation ids before `--continue`, verify cancellation and clean up stuck children, and send Ctrl+C with Escape on stop.
- Expand secret redaction (authorization/bearer, access/refresh tokens, API keys, client secrets, private keys, cookies, session tokens, query-string tokens) and keep visible tool activity in `sanitizeFreebuff` while dropping reasoning and ads.

### Installers, CLI & CI

- Split installation into `src/install/{codex,claude,common}.ts`; add `install claude [--write] [--project]` (merges safely into `~/.claude.json` or `./.mcp.json`) and set Codex `tool_timeout_sec = 3600` for long turns; `install` still defaults to Codex.
- Rewrite the CLI: full usage text, `doctor --json` with structured diagnostics and nonzero exit when nothing is detected, centralized `version` from package.json.
- Add `tsconfig.test.json` and `typecheck:test` so tests are typechecked; CI runs it on every matrix job and performs a packed-tarball smoke test (install, version, doctor, installers).

### Packaging

- Centralize the package version; the shipped `dist` matches `package.json` (0.2.0).

## 0.1.17

- Restore full MCP v2 tool parity and structured results.
- Stream ACP progress, map ACP sessions to backing CLI identities, and stop backing work on cancellation.
- Emit MCP resource updates when Desktop progress changes.
- Fix CI workflow YAML parsing.

## 0.1.16

- Add MCP v2 stdio serving with structured tool results and Freebuff resources.
- Add `serve-acp`, an ACP session/prompt adapter with live session updates and cancellation.
- Keep the v1 stdio server available as `serve-v1` during the migration.

## 0.1.14

- Harden project-file reads with sensitive-name blocking, text-only validation, redaction, and a 1 MB limit.
- Redact normalized live-event fields, fix progress staleness, and close the progress lost-wakeup race.
- Bound and clean up CLI PTY sessions and neutralize terminal control input.
- Add granular hybrid mutation capability registration and use the safer node-pty beta.14 Windows baseline.

## 0.1.11

- Update `node-pty` to `1.2.0-beta.15`, which includes the macOS `spawn-helper` packaging fix for `posix_spawnp failed`.

## 0.1.6

- Add normalized, redacted, bounded live Desktop progress via `/api/events`.
- Add `get_thread_progress` polling and bounded `watch_thread` long-polling.
- Add phase labels, progress summaries, active-thread watching, fresh readiness metadata discovery, and a safe Codex install helper.
- Omit detailed reasoning deltas from normalized live progress by default.
- Keep live event history in memory and stop the event client on runtime disposal.

## 0.1.4

- Document cross-platform Codex, CLI, and HTTP setup.
- Correct the HTTP security policy and explain optional Cloudflare use.

## 0.1.3

- Add readiness metadata discovery for Desktop port and launch ID.
- Verify the launch ID through `/healthz` before enabling Desktop mutations.
- Send `x-freebuff-launch-id` on authenticated Desktop requests.

## 0.1.2

- Add native listener probing as a Desktop dynamic-port discovery fallback.
- Omit mutation tools when the active runtime is read-only.
- Validate project and thread payload fields at the API boundary.
- Use deterministic path-derived CLI history keys while retaining legacy lookup.

## 0.1.1

- Discover Freebuff Desktop on Windows, macOS, and Linux from dynamic-port logs.
- Prefer Desktop by default, with explicit CLI PTY mode and CLI fallback.
- Keep Desktop mutations disabled until Freebuff's launch authorization contract is verified.
- Improve CLI executable discovery, project-key overrides, cleanup, and safe file listings.
- Exclude test files from published build output and add runtime coverage.

## 0.1.0

- Initial secure stdio MCP bridge with capability probing, project and thread reads, safe file access, and guarded Desktop actions.
# 0.1.7

Added structured runtime status and live progress availability.

Added active thread discovery from Desktop snapshots.

Added visible history search and attachment metadata tools.

Improved progress phase labels and readiness process checks.

Added HTTP Origin validation and a bounded request rate limit.

Expanded setup and compatibility guidance.
# 0.1.12

- Select Desktop first with CLI fallback when no CLI-only flag is configured.
- Make direct GitHub npm installs use the committed compiled runtime.
- Correct the reported CLI and MCP server version.

# 0.1.9

Removed the accidental Cursor specific integration.
# 0.1.17

- Restore full MCP v2 tool parity, including writes, progress, file, history, and attachment operations.
- Fix CI workflow YAML parsing and clarify the generated legacy/CLI configuration entries.

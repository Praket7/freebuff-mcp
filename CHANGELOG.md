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

### Desktop HTTP contract audit (real-API fixes)

Every adapter's tests had used `fetch` stubs or scripted backends, so the bridge was never checked against the Desktop's real HTTP contract. Verifying against a live Freebuff Desktop (and its bundled orchestrator) surfaced these defects:

- **Thread creation did not exist for Desktop.** `DesktopBackend` had no `createSession`, and the composite backend asserted its way past that, so `start_thread`, an auto-created `run_turn`/`send_message`, and ACP `session/new` all died with `TypeError: ... is not a function`. Threads are now created with `POST /api/threads` (the route the Desktop UI uses), verified against the live API.
- **`list_threads` returned projects, not threads.** `/api/projects` nests `threads` inside each project; the backend returned the project array. It now flattens, so `list_threads` and `get_active_work` work.
- **`get_thread` lost all metadata.** `/api/thread/:id` returns `{ thread, messages, items }`; the raw wrapper was forwarded, so `id`/`title`/`turnState`/`model` read as `undefined`. It is now flattened.
- **`list_thread_attachments` could never succeed.** It called `/api/thread/:id/attachment`, which requires a `path` parameter and returns a single file. Attachments are now collected from the thread's messages.
- **`run_turn` reported `completed` before any work happened.** `sendMessage` returned as soon as the Desktop acknowledged the prompt, and it unsubscribed from the event stream at the same moment, so live progress was dropped too. It now stays subscribed and waits for the thread's terminal state (Desktop `turnState: running | idle`, with `lastTurnOutcome`/`lastTurnFinishedAt`), mapping failures to `failed`, cancellation to `cancelled`, and an unconfirmed turn to a non-terminal `waiting_for_user` rather than claiming success. Bounded by a 30-minute deadline and a 60-second "never started" grace.
- **`get_diff` was invented.** The Desktop exposes real change routes: `GET /api/thread/:id/changes` and `/changes/diff?file=&scope=`. `get_diff` now returns the real change summary and real `{ patch }` text, and surfaces `binary`/`tooLarge`/`error` results instead of fabricating anything.
- Add a `get_changes` tool for the Desktop change summary.
- **`resume_thread` sent `/resume` to the model as a prompt.** It submitted the text `/resume` through the message route for every backend, but `/resume` is a CLI *harness* command — the Desktop unpauses a thread's queue through its own `POST /api/thread/:id/resume` route (which is what tool, the Desktop backend, and legacy MCP v1 all use). On the Desktop this started a turn whose prompt was the literal string `/resume`. It now routes by backend.

### Verification you can rerun

- Add a fake Desktop HTTP server (`test/helpers/fake-desktop.ts`) that serves the real contract, so CI — which has no Desktop — tests the actual wire protocol: status codes, payload wrappers, nested thread lists, SSE snapshot frames, and turn lifecycle.
- Correct that fake against the bundled orchestrator. It had acknowledged a prompt with `{ ok, itemId }`, but the real Desktop returns `{ ok, queued }` and no turn id at all, so a test briefly pinned an identity the Desktop never sends. `backendTurnId` is now documented and tested as unset when Freebuff supplies no turn identity — the bridge does not invent one — and the `/agent` (`{ ok, model }`) and `/effort` (`{ ok, thread }`) responses match the orchestrator too.
- Add `test/desktop-wire.test.ts` pinning the real payload shapes (captured from a live Desktop) plus `test/desktop-http-integration.test.ts` driving real sockets, including that a turn is awaited and that cancellation/failure are reported correctly.
- Add `test/http-transport.test.ts` (bearer auth, `Origin` validation, 404s, malformed/oversized bodies, 429 rate limiting, full MCP handshake) and `test/acp-wire.test.ts` (`initialize` capabilities, `session/new` creating a real thread, `session/prompt` → `end_turn`, `session/cancel` → `cancelled`) — both surfaces previously had **zero** wire-level coverage.

### Progress honesty (canonical stream health)

- **`connected`/`stale` were never true in the canonical path.** `EventStore.setConnected` was only ever called by the legacy runtime, so MCP v2, the HTTP transport, and ACP reported `connected: false, stale: true` in every progress snapshot — including while events were actively flowing. `get_thread_progress_summary` returned the same shape for a real, live turn as for a thread that does not exist. Backends can now report stream health through an optional `onStreamHealth`, the Desktop backend wires its real SSE state into it (with the current value delivered on subscribe), the composite backend delegates to whichever backend owns the stream, and the session manager feeds it into the shared store. Backends with no persistent stream (CLI/PTY) track turn-scoped liveness instead of reporting a permanent false.
- **The wire tests were borrowing a live Desktop.** They constructed `new DesktopBackend()` with no options, so discovery ran against the machine: on a developer box it found a running Desktop and the stubbed `fetch` answered everything, while CI — which has no Desktop — failed all seven with `FREEBUFF_DESKTOP_NOT_FOUND`. They now pin an explicit loopback origin and throw on any foreign origin, so a live dependency cannot silently return. Verified by reproducing the CI failure locally (empty `HOME`, `PATH` without `ps`/`lsof`) and then confirming the suite passes in that same environment.
- **A cleanly closed stream left `connected` stuck true.** `SseClient` only cleared its connection flag in the error path, so when the server closed the connection cleanly — which is what a Desktop restart does — the bridge kept reporting a live stream while nothing was arriving. The end of a stream now reports a disconnection, and the reconnect that follows is reported too.
- **`eventGapSuspected` was always false.** `EventStore.setGapSuspected` had no caller, so a field returned by `get_turn`, `watch_turn`, `watch_thread`, and `get_thread_progress` could never report the thing it names. Losing an established stream now raises a suspected gap and receipt of a full state snapshot clears it, so clients can tell whether they may have missed progress.
- Document that the Desktop event stream has no heartbeat (measured: a burst of snapshot frames on connect, then silence while idle), so `lastEventAt` freshness must not gate `liveProgress`.

### Capability honesty, efficiency & hardening

- **A read-only Desktop advertised capabilities it could not perform.** `DesktopBackend.probe()` hard-coded `canCreateSession: true`, and the composite backend overrode the field to `true` again, so a Desktop without write authorization claimed it could create threads. Creating a thread is a write; both now report it only when the write-authorization challenge passed.
- **The CLI advertised model and reasoning capabilities it never implemented.** `CliBackend.probe()` reported `canSetModel`/`canSetReasoning`, but the backend had no such methods — and MCP `set_model`/`set_reasoning` reached into `backend.desktop` directly, so a CLI session would have been changed through the Desktop. The CLI backend now implements both through the harness slash commands (`/model`, `/reasoning`) that the legacy path already used, the composite backend routes each call to the backend that owns the session, and the MCP tools use the backend contract instead of `as unknown as` casts.
- **Write authorization was re-checked over HTTP on every write.** Each send/stop/resume paid an extra `/healthz` round-trip. The write path now reuses a recent result for three seconds while the write request itself remains the authority; status queries always check afresh so `probe()` can never report stale authorization (a regression the suite caught). Measured: a second consecutive thread creation drops from 20 ms to 4 ms.
- **A Desktop rejection discarded the Desktop's explanation.** Any non-retriable status became a bare `HTTP 400`; the Desktop's own `error`/`message` (for example `no project` or `invalid model`) is now included, redacted and truncated.
- **The first status call reported a healthy Desktop as `stale`.** `probe()` now gives a just-started event stream a bounded 1.5 s to connect, once per process, so `freebuff_status` no longer opens with a misleading sample.
- HTTP transport hardening: rate-limiter buckets are pruned so the limiter cannot grow without bound, and request bodies are size-checked incrementally instead of re-concatenating every chunk.
- Remove unbounded dead state: the event store kept a per-thread **and per-turn** activity map that nothing outside a test read (per-thread recency already comes from the events themselves), and the session manager carried an unused resolver map. The equivalent staleness assertion now uses `latestEventAt`, the signal the bridge actually reports.

### Legacy adapters & parity

- Delete the duplicated legacy Desktop implementation (`src/events.ts` and the private discovery/SSE/progress store inside `src/runtime.ts`). MCP v1 (`serve-v1`) and the HTTP transport (`serve-http`) now reuse the canonical `desktop/discovery.ts`, `desktop/sse.ts`, `desktop/event-adapter.ts`, and `bridge/event-store.ts`, so Desktop discovery — including removing the broad all-listener port scan from the legacy path — and SSE parsing exist exactly once.
- Fix `liveProgress` in the legacy runtime: it was reported as `connected` whenever `/api/projects` succeeded. It now reflects the event stream's own health, exactly like the v2 Desktop backend.
- Add the `get_thread_progress_summary` and `get_diff` read tools to MCP v2 so the v2 catalog matches v1. `get_diff` returns the changed-file list derived from live events and only includes diff text when the Desktop exposes it — the bridge never fabricates a diff.
- `doctor` now reports the timestamp of the most recent live event (`desktop.lastEventAt`) and gives the event stream a bounded moment to prove itself before reporting its state, so a healthy Desktop is no longer reported as `stale` on the first sample. Backend capabilities expose the same value as `lastEventAt`.
- Add end-to-end coverage for the legacy adapter (`test/integration/mcp-v1.test.ts`) that drives the real MCP client through `serve-v1` onto the canonical store.

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

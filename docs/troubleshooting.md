# Troubleshooting

Run `freebuff-mcp doctor` (or `freebuff-mcp doctor --json`) first — it reports the selected backend, Desktop authorization, event-stream state (including `desktop.lastEventAt`, the timestamp of the most recent live event), CLI detection, handoff status, and recent diagnostic errors.

## Desktop not detected

**Symptoms:** `freebuff_status` → `{ "connection": "not_running" }`; doctor shows `desktop.detected: false`.

**Fixes:**
1. Start Freebuff Desktop and open a project.
2. If discovery still fails, set `FREEBUFF_ORCHESTRATOR_URL` to the Desktop's loopback URL (visible in doctor output once found once).
3. On macOS/Linux the bridge can find the orchestrator process automatically; ensure the bridge runs as the same user as Desktop.

## Desktop read-only

**Symptoms:** `authorization: "read_only"`, write tools return `FREEBUFF_DESKTOP_AUTH_REQUIRED`.

**Fixes:** The launch-ID health check failed or no launch id was found. Restart Freebuff Desktop (it re-issues a short-lived launch id) or reopen the project, then retry. The bridge never fabricates authorization.

## Desktop authorization expired / rotated

**Symptoms:** sudden `HTTP 403` on writes; the bridge usually self-heals by rediscovering.

**Fixes:** Retry once; if it persists, restart Desktop. The bridge invalidates its connection cache on 401/403/404, 5xx, and network errors and rediscovers automatically (bounded retries).

## Event stream disconnected

**Symptoms:** `liveProgress: "unavailable"` or `"stale"`; `watch_thread` times out with no events; `doctor` shows no `desktop.lastEventAt`.

**Fixes:** The stream reconnects with bounded backoff and `Last-Event-ID` automatically. If it stays down, restart Desktop. `connected` is only reported when the SSE stream itself is healthy — a working `/api/projects` alone never sets it, in any adapter (v2, v1, HTTP). A `liveProgress: "stale"` immediately after startup usually means the stream is still connecting; re-run `doctor` a moment later.

## CLI not installed

**Symptoms:** `FREEBUFF_CLI_NOT_INSTALLED`, doctor `cli.installed: false`.

**Fixes:** Install the Freebuff CLI, or point `FREEBUFF_CLI_PATH` at the executable.

## CLI not authenticated

**Symptoms:** `FREEBUFF_CLI_NOT_AUTHENTICATED`.

**Fixes:** Run the Freebuff CLI once interactively and sign in.

## CLI already running

**Symptoms:** `FREEBUFF_CLI_ALREADY_RUNNING` when a managed session starts.

**Fixes:** Close the other CLI session in that project, or set `FREEBUFF_CLI_TAKEOVER=1` to accept the takeover prompt automatically.

## node-pty / posix_spawnp failure

**Symptoms:** `FREEBUFF_PTY_LAUNCH_FAILED` with a `posix_spawnp failed` detail (macOS/Linux) or ConPTY errors (Windows).

**Fixes:**
1. Verify the CLI is executable and its interpreter exists.
2. Ensure the installed `node-pty` prebuilt matches your Node version/architecture; reinstall with `pnpm install --frozen-lockfile`.
3. On macOS, repeated launches after many PTY sessions can exhaust pseudo-terminal descriptors — restart the bridge.
4. On Windows, a ConPTY failure usually means an outdated Windows 10 build; update Windows or use Desktop mode.

## MCP tool timeout

**Symptoms:** Codex reports the tool timed out mid-turn.

**Fixes:** Use the installer output and set `tool_timeout_sec = 3600` (and `startup_timeout_sec = 20`) in the `[mcp_servers.freebuff]` entry. `run_turn` waits for the whole Freebuff turn by design; use `send_message` + `watch_turn` if you prefer async polling.

## Codex not seeing tools

**Fixes:** Run `freebuff-mcp install codex --write`, restart Codex, then check `freebuff-mcp doctor`. Ensure only one `[mcp_servers.freebuff]` entry exists (the installer refuses duplicates).

## Claude Code not seeing the server

**Fixes:** Run `freebuff-mcp install claude --write` (user scope) or `--project`, then restart Claude Code or run `/mcp` to inspect connection state. Confirm `~/.claude.json` (or `./.mcp.json`) has the `freebuff` entry under `mcpServers`.

## Stale configuration

**Symptoms:** the server binary path in your client config points at an old checkout.

**Fixes:** Re-run the installer for your client after moving or reinstalling the package; it emits the exact current paths.

## Session/turn errors

- `FREEBUFF_SESSION_NOT_FOUND` / `FREEBUFF_TURN_NOT_FOUND` — the bridge restarted or the id was mistyped; call `start_thread` again.
- `FREEBUFF_TURN_ALREADY_ACTIVE` — one active turn per session; `stop_turn` first or wait for the terminal state.
- `FREEBUFF_DESKTOP_HANDOFF_INVALID` — the handoff file failed validation; the reason (`handoff_expired`, `handoff_dead_pid`, …) appears in doctor output.

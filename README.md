# freebuff-mcp

An MCP bridge for a locally installed and signed-in Freebuff CLI or Desktop installation. It gives an MCP client bounded access to Freebuff sessions, local CLI history, live CLI output, and safe project-file reads.

## Requirements

- Windows, macOS, or Linux
- Node.js 20 or newer
- Freebuff CLI or Desktop installed and signed in
- Codex CLI or another MCP-compatible client

The bridge uses the Freebuff installation on the same computer. It does not share credentials or expose your chats to other users.

## Install from npm

```bash
npm install --global freebuff-mcp
freebuff-mcp doctor
```

The package includes its compiled runtime files. No local build is required for npm users.

## Configure Codex for Desktop-first discovery

By default the bridge probes the locally running Freebuff Desktop first, then falls back to the CLI if Desktop is unavailable. This requires no CLI-mode flag:

```toml
[mcp_servers.freebuff]
command = 'freebuff-mcp'
args = ['serve']
enabled = true
```

Desktop discovery reads dynamic port/launch metadata when Freebuff exposes a readiness file, then verifies the launch ID through `/healthz`. If that handshake is unavailable, it stays read-only. Use the explicit CLI configuration below when you need bridge-owned prompt injection.

## Configure Codex for explicit Freebuff CLI mode

Add this server to `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` on Windows):

```toml
[mcp_servers.freebuff]
command = 'freebuff-mcp'
args = ['serve']
enabled = true

[mcp_servers.freebuff.env]
FREEBUFF_MCP_CLI_MODE = 'pty'
FREEBUFF_PROJECT_ROOT = 'C:\Users\YOUR_NAME\Documents\FreeBuff WORK'
# Set this when two project roots share the same basename.
# FREEBUFF_PROJECT_KEY = 'FreeBuff WORK'
```

On macOS or Linux, use the same block and set the root to a Unix path such as `/Users/YOUR_NAME/Desktop/freebuff-work`.

Restart Codex and ask it to call `freebuff_status`, then `list_threads`.

Run `freebuff-mcp install` to print a ready-to-paste configuration using the current executable, or `freebuff-mcp install --write` to append the Desktop-first entry to `%USERPROFILE%\\.codex\\config.toml` (or `~/.codex/config.toml`). The write mode refuses to overwrite an existing `freebuff` entry.

CLI mode can start a managed Freebuff session, inject prompts, monitor live output, discover the local conversation ID, resume persisted CLI chats, read visible history, list safe project files, and read individual project files. Reasoning changes are supported through Freebuff slash commands. Model changes require Freebuff's interactive new-session model picker.

If Desktop discovery is configured with `FREEBUFF_ORCHESTRATOR_URL`, Desktop remains the selected runtime unless `FREEBUFF_MCP_CLI_MODE = 'pty'` is set in the server's environment. For a CLI installed outside PATH, set `FREEBUFF_CLI_PATH` to its absolute executable path (for example `/Users/YOUR_NAME/.config/manicode/freebuff`). `freebuff_status` will identify which runtime was selected.

On macOS, a `posix_spawnp failed` error is emitted with the executable and working directory. Verify the CLI is executable, its interpreter exists, and the native `node-pty` binary matches the Node architecture. Repeated failures after many PTY launches can indicate the known node-pty macOS pseudo-terminal descriptor leak; restart the bridge and update node-pty when a fixed stable release is available.

### Live Desktop progress

When Desktop is discovered, the bridge subscribes to its read-only `/api/events` stream. Use `get_thread_progress` with a thread ID to poll bounded, in-memory progress events. Pass `afterSequence` from the previous response for incremental reads. `watch_thread` provides bounded long-polling for up to 30 seconds. These views can show turn state, assistant updates, tools, command summaries, file changes, and completion/failure while a task is running. `get_thread` remains the saved snapshot and may include a `live` summary; event history is intentionally not persisted. CLI mode reports Desktop live events as unavailable and continues to expose PTY output.

For a simpler view, call `get_thread_progress_summary`. It reports the current phase (Planning, Reading files, Running tests, Editing files, Reviewing changes, Waiting for input, Completed, or Failed), latest meaningful update, active tool/command, changed files, last error, seconds since the last event, and whether the stream is stale. `watch_active_threads` returns the latest summary for every active Desktop thread. Detailed reasoning deltas are omitted by default.

## Run directly with npx

The same server can be configured without a global install:

```toml
[mcp_servers.freebuff]
command = 'npx'
args = ['-y', 'freebuff-mcp@latest', 'serve']
enabled = true

[mcp_servers.freebuff.env]
FREEBUFF_MCP_CLI_MODE = 'pty'
FREEBUFF_PROJECT_ROOT = 'C:\Users\YOUR_NAME\Documents\FreeBuff WORK'
```

## Build from GitHub

For development or a local source build, build it from GitHub:

```bash
git clone https://github.com/Praket7/freebuff-mcp.git
cd freebuff-mcp
pnpm install
pnpm build
```

Then point Codex at `dist/src/cli.js`:

```toml
[mcp_servers.freebuff]
command = 'node'
args = ['C:\path\to\freebuff-mcp\dist\src\cli.js', 'serve']
enabled = true

[mcp_servers.freebuff.env]
FREEBUFF_MCP_CLI_MODE = 'pty'
FREEBUFF_PROJECT_ROOT = 'C:\Users\YOUR_NAME\Documents\FreeBuff WORK'
```

## Optional HTTP transport

You do not need HTTP or Cloudflare for local Codex use. Stdio is the safer default. Use HTTP only when another MCP client must reach this bridge.

```bash
$env:FREEBUFF_MCP_TOKEN = '<long-random-value>' # PowerShell
freebuff-mcp serve-http
```

On macOS/Linux, use `export FREEBUFF_MCP_TOKEN='<long-random-value>'` before starting it. It listens on `127.0.0.1:8788` by default, and `/mcp` always requires `Authorization: Bearer <token>`. Non-loopback binding is refused unless `FREEBUFF_MCP_ALLOW_REMOTE=1`; if enabled, use a trusted HTTPS tunnel or private VPN and never expose the port directly to the Internet.

### Cloudflare is optional

Cloudflare is only one possible HTTPS tunnel for remote access. It is not required for local use, npm publication, GitHub, or Desktop discovery. Use it only if you specifically want a Cloudflare-managed hostname for the authenticated HTTP bridge.

## Development and verification

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

The bridge rejects unsafe identifiers and paths, redacts credential-like fields, and never returns Freebuff credentials.

This package does not contain an OpenCode adapter. OpenCode integrations must send model selections as `{ providerID, modelID }` and use provider-specific variants; `low`/`high` are not agent names. OpenCode session model/reasoning mutation should not be exposed unless the adapter implements the corresponding supported server operation. Configure and authenticate OpenCode separately with its own CLI/server tools.

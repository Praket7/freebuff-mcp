# Security

## Trust model

`freebuff-mcp` is a local bridge between your MCP client and your own Freebuff installation. It runs with your user's privileges on your machine.

The bridge **does not**:

- dump or scrape any process's memory (including Freebuff Desktop's)
- attach debuggers to other processes
- extract credentials from undocumented privileged storage
- bypass Freebuff's permission checks or Electron security boundaries
- expose your Freebuff auth token through tools, resources, or logs
- bind to a non-loopback interface by default

## How authorization works

Desktop writes are gated on the Desktop's own launch-ID contract: the Desktop issues a short-lived launch id, and the bridge must present it (`x-freebuff-launch-id`) to a `/healthz` challenge that explicitly answers `{ ok: true }`. Without a passing challenge, every write path returns `FREEBUFF_DESKTOP_AUTH_REQUIRED` and the bridge stays read-only.

The optional handoff file (`FREEBUFF_MCP_HANDOFF_FILE`, or the platform-default location when unset: `%APPDATA%\Freebuff\mcp-handoff.json` on Windows, `~/Library/Application Support/Freebuff/mcp-handoff.json` on macOS, `~/.config/freebuff-desktop/mcp-handoff.json` on Linux) is written by the Desktop into the **current user's** config directory and contains only a loopback URL, a short-lived launch id, a PID, and an expiry. Before use the bridge validates format, version, loopback-ness, live PID, expiry, current-user ownership, and owner-only POSIX permissions, then still challenges the launch id over HTTP. Possession of the file alone never grants writes.

Discovery never reads another process's environment: launch ids come only from the handoff/readiness files the Desktop itself writes, and every configured or file-supplied candidate URL must be loopback before any request (or launch-id header) is sent to it.

## Data handling

- Secrets (Authorization headers, bearer tokens, access/refresh tokens, API keys, client secrets, private keys, cookies, session tokens, query-string tokens) are redacted at the adapter boundary before any event, message, or file content is returned to a client.
- Hidden reasoning/ad content from Freebuff is dropped; visible tool activity (tool name, command, changed files) is preserved in redacted form.
- Project file reads are confined to the configured project root, resolve symlinks before containment checks, reject traversal, refuse protected files/directories (`.env`, `.git-credentials`, `.aws`, `.ssh`, keys, credentials, …), reject binaries, and cap at 1 MB.
- Identifiers are validated (`^[A-Za-z0-9._:-]{1,200}$`) before use.
- The event store is in-memory, bounded (count/bytes/TTL), and never persisted.
- Diagnostics (`doctor`) print at most the basename of the CLI path and never print launch ids, tokens, cookies, or full Authorization headers.
- HTTP transport: loopback binding, constant-time bearer comparison, Origin validation, bounded request bodies, and rate limiting. Remote binding requires explicit opt-in; remote use requires trusted HTTPS/private networking.

## Reporting

See [CONTRIBUTING.md](CONTRIBUTING.md) and the project's GitHub issues. Please do not include secrets in bug reports; redacted doctor `--json` output is appreciated.

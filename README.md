# freebuff-mcp

An MCP bridge for a locally installed and signed-in Freebuff CLI or Desktop installation. It gives an MCP client bounded access to Freebuff sessions, local CLI history, live CLI output, and safe project-file reads.

## Requirements

- Windows, macOS, or Linux
- Node.js 20 or newer
- Freebuff CLI or Desktop installed and signed in
- Codex CLI or another MCP-compatible client

The bridge uses the Freebuff installation on the same computer. It does not share credentials or expose your chats to other users.

## Install from npm

Once the package is available on npm:

```bash
npm install --global freebuff-mcp
freebuff-mcp doctor
```

The package includes its compiled `dist` files and builds them automatically when packed.

## Configure Codex for Freebuff CLI mode

Add this server to `~/.codex/config.toml`. On Windows, this is usually `C:\Users\YOUR_NAME\.codex\config.toml`:

```toml
[mcp_servers.freebuff]
command = 'freebuff-mcp'
args = ['serve']
enabled = true

[mcp_servers.freebuff.env]
FREEBUFF_MCP_CLI_MODE = 'pty'
FREEBUFF_PROJECT_ROOT = 'C:\Users\YOUR_NAME\Documents\FreeBuff WORK'
```

Restart Codex and ask it to call `freebuff_status`, then `list_threads`.

CLI mode can start a managed Freebuff session, inject prompts, monitor live output, discover the local conversation ID, resume persisted CLI chats, read visible history, list safe project files, and read individual project files. Reasoning changes are supported through Freebuff slash commands. Model changes require Freebuff's interactive new-session model picker.

## Run directly with npx

After publication, the same server can be configured without a global install:

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

Until the npm package is published, build it locally:

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

## HTTP transport

For a remote MCP client, run the authenticated local HTTP transport:

```bash
set FREEBUFF_MCP_TOKEN=<long-random-value>
freebuff-mcp serve-http
```

It listens on `127.0.0.1:8788` by default. Put it behind a trusted HTTPS tunnel before connecting remotely; never expose the port directly to the Internet.

## Development and verification

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

The bridge rejects unsafe identifiers and paths, redacts credential-like fields, and never returns Freebuff credentials.

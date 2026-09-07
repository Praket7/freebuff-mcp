# freebuff-mcp

`freebuff-mcp` is a third party, open source MCP bridge for a locally installed Freebuff Desktop orchestrator. It keeps the local app as the source of truth and exposes only semantic, bounded tools.

## Install

```bash
npx freebuff-mcp@latest install
```

The initial release also runs directly with `npx -y freebuff-mcp@latest`. Use `freebuff-mcp doctor` to see whether a compatible local orchestrator is available.

For a remote MCP client, start the authenticated HTTP transport locally:

```bash
set FREEBUFF_MCP_TOKEN=<long-random-value>
npx -y freebuff-mcp@latest serve-http
```

It binds to `127.0.0.1:8788` by default. Put it behind a trusted HTTPS tunnel before connecting a remote client. Never expose the HTTP port directly to the Internet.

The bridge does not need an API key. It never returns or forwards Freebuff credentials. If Desktop is unavailable, read tools remain safe and write tools report that the runtime is read only.

## What is verified

The public Freebuff source is MIT licensed. The community `freebuff-bridge` repository was used only as a research lead because it has no repository license file. Its documented localhost route names informed independent contract validation and are not copied code.

The installed environment verified live read access to Freebuff Desktop projects, threads, visible messages, and project files. The current Desktop build rejects independent mutation callers with HTTP 403, so this bridge reports read-only mode and does not attempt to bypass that protection. Attachments, model switching, reasoning controls, and remote ChatGPT operation are not claimed as live write capabilities. See [docs/compatibility.md](docs/compatibility.md).

## Security

Project reads are canonicalized, symlink-aware, confined to a discovered project root, and deny common secret files. There is no shell, SQL, arbitrary HTTP, or arbitrary code tool. See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```


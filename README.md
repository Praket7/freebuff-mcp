# freebuff-mcp

`freebuff-mcp` is a third party, open source MCP bridge for a locally installed Freebuff Desktop orchestrator. It keeps the local app as the source of truth and exposes only semantic, bounded tools.

## Install

```bash
npx freebuff-mcp@latest install
```

The initial release also runs directly with `npx -y freebuff-mcp@latest`. Use `freebuff-mcp doctor` to see whether a compatible local orchestrator is available.

The bridge does not need an API key. It never returns or forwards Freebuff credentials. If Desktop is unavailable, read tools remain safe and write tools report that the runtime is read only.

## What is verified

The public Freebuff source is MIT licensed. The community `freebuff-bridge` repository was used only as a research lead because it has no repository license file. Its documented localhost route names informed independent contract validation and are not copied code.

The installed environment used for this build did not expose a Freebuff Desktop app or a responding orchestrator, so live Desktop control, attachments, model switching, reasoning controls, and remote ChatGPT operation are not claimed as verified. See [docs/compatibility.md](docs/compatibility.md).

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


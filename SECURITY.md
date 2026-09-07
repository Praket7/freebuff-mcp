# Security policy

Please report security issues privately to the repository maintainers. Do not include credentials, tokens, cookies, or private source code in an issue.

## Security model

- Stdio is the default transport and stays on the local machine.
- Optional HTTP binds to `127.0.0.1` by default.
- Every `/mcp` request requires `Authorization: Bearer <FREEBUFF_MCP_TOKEN>`.
- Non-loopback binding is refused unless `FREEBUFF_MCP_ALLOW_REMOTE=1`; when enabled, use a trusted HTTPS tunnel or private network.
- `/healthz` is unauthenticated only for loopback health checks; remote health checks require the bearer token.
- Desktop mutations require a dynamically discovered launch ID and successful `/healthz` verification. Otherwise mutation tools are not registered.
- CLI writes use a bridge-owned PTY and do not take over an existing CLI process by default.
- Project paths are confined to the configured root, unsafe identifiers are rejected, and credentials are never returned or logged.

This project has not undergone an independent security audit. Treat remote HTTP exposure as an advanced deployment and review the configuration before enabling it.


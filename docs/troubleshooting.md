# Troubleshooting

Run `freebuff-mcp doctor`. If it reports no orchestrator, open Freebuff Desktop and retry. You can set `FREEBUFF_ORCHESTRATOR_URL` when the app reports a different loopback port. Do not expose that URL publicly.

To force the CLI, set `FREEBUFF_MCP_CLI_MODE=pty`; this takes precedence over Desktop discovery. If the CLI is installed at a nonstandard location, also set `FREEBUFF_CLI_PATH` to its absolute executable path. On Unix, the file must have execute permission. A `posix_spawnp failed` message from node-pty is a native launch failure, not a Desktop launch-authorization failure; check the executable, interpreter, Node architecture, and node-pty installation.

OpenCode-specific errors are outside this bridge. Its current server API expects structured model fields (`providerID` and `modelID`) and provider-specific variants; do not serialize a model as an agent or treat a reasoning variant as an agent name. An accepted prompt can still fail later if the provider credential is invalid, so check OpenCode authentication separately.

For Cursor, run `freebuff-mcp cursor-install` from the project folder for a project configuration. Use `freebuff-mcp cursor-install --write --global` for a global configuration. Check Cursor MCP settings and its output panel after saving. The generated command uses an absolute Node path, which avoids GUI PATH differences.

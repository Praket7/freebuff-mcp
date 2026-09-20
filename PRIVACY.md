# Privacy

## What stays on your machine

- All bridge state (sessions, turns, progress events) lives in process memory with bounded retention and is never persisted or transmitted anywhere by the bridge itself.
- Desktop discovery reads only local metadata you or Freebuff Desktop placed in the current user's config/log directories.
- The handoff file contains a loopback URL and short-lived launch id — no credentials — and stays in the current user's config directory.
- `freebuff-mcp doctor` output stays local unless you share it.

## What flows where

- **MCP client ↔ bridge (stdio/HTTP):** tool arguments and structured results only. The bridge sends nothing to your MCP client beyond what a tool call returns (plus MCP protocol traffic: progress notifications, resource updates).
- **Bridge ↔ Freebuff Desktop (loopback HTTP/SSE):** read requests (`/api/projects`, thread reads), authorized writes you trigger (send message, stop, resume, model/effort changes), and the local event stream. This traffic never leaves your machine.
- **Freebuff's normal backend:** when a Freebuff turn actually runs, Freebuff itself (Desktop or CLI) talks to Freebuff's servers exactly as it does without this bridge — your prompts, project context, and results flow through Freebuff under Freebuff's own terms and privacy policy. The bridge adds no third-party endpoints and performs no telemetry of its own.

## What the bridge never does

- No analytics, telemetry, or crash reporting.
- No network listeners except the optional, authenticated, loopback-by-default HTTP transport.
- No persistent storage of conversation content.

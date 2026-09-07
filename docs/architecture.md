# Architecture

The MCP layer depends on a small runtime interface. Desktop discovery reads dynamic localhost ports from platform-specific Freebuff logs and probes `/api/projects`; there is no fixed fallback port. By default the bridge prefers a responding Desktop orchestrator, then falls back to the installed CLI PTY. CLI history is read from Freebuff's local chat store, and project reads are canonicalized and confined to the configured project root. Desktop mutation calls remain read-only unless a verified Freebuff authorization contract is available.

After Desktop discovery, `DesktopEventClient` subscribes to the local `/api/events` SSE endpoint using the verified launch-ID header. It normalizes untrusted events into a bounded per-thread in-memory `ProgressStore` with sequence numbers, TTL eviction, redaction, and reconnect backoff. `get_thread_progress` polls that store and `watch_thread` waits for up to 30 seconds; neither tool writes to Freebuff or persists event data. Saved snapshots and live events remain separate consistency domains.

The community bridge was a research lead, not a dependency. Its repository had no license file, so this project contains independent code.

```mermaid
flowchart LR
  Client[MCP client] --> Stdio[freebuff-mcp stdio]
  Stdio --> Runtime[Capability driven runtime]
  Runtime --> Desktop[Freebuff Desktop dynamic localhost orchestrator]
  Runtime --> CLI[Freebuff CLI managed PTY]
  Runtime --> Files[Approved project roots]
```


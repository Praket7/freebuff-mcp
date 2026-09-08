# Compatibility

| Capability | Status in this build |
| --- | --- |
| Node.js runtime | Node 20 or newer |
| MCP stdio | Implemented |
| Desktop dynamic `/api/*` discovery | Readiness metadata, platform logs, and native listener fallback |
| Projects, threads, visible messages | Implemented and live verified |
| Safe project file reads | Implemented; shallow file listing and bounded reads |
| Model, stop, resume writes | Enabled only after dynamic Desktop launch-ID verification; CLI writes use managed PTY |
| Attachments | Not yet implemented |
| Authenticated Streamable HTTP relay | Implemented, loopback by default |
| Cloudflare deployment | Optional only for remote HTTP access; not required for local use |
| CLI PTY and local chat history | Implemented; CLI writes require the managed PTY |
| Live Freebuff Desktop write verification | `/healthz` launch-ID handshake; otherwise read-only |
| Live Desktop progress | `/api/events` SSE with polling via `get_thread_progress` and bounded `watch_thread`; in-memory only |
| Progress summaries | `get_thread_progress_summary` and `watch_active_threads`; user-facing phases and stale/error indicators |
| Automatic Desktop readiness | Reads fresh port, launch ID, PID, and timestamp metadata; rejects stale records and retries live listener candidates |
| Installer helper | `install` prints a current-path Codex entry; `install --write` appends without overwriting an existing entry |
| OpenCode adapter | Not included; OpenCode model/session operations must be implemented by a separate adapter using its server API contract |


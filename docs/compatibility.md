# Compatibility

Feature support by platform, client, and backend. All entries reflect tested behavior in CI (ubuntu/macos/windows × Node 20/22/24) unless marked otherwise.

## Platforms

| Capability | Windows | macOS | Linux |
| --- | --- | --- | --- |
| MCP v2 stdio | ✅ | ✅ | ✅ |
| Desktop discovery (readiness/log/process) | readiness + log | + process env | + process env |
| Desktop handoff file | ✅ | ✅ | ✅ |
| Desktop writes (launch-ID health check) | ✅ | ✅ | ✅ |
| SSE live progress | ✅ | ✅ | ✅ |
| CLI PTY fallback (ConPTY/POSIX) | ✅ | ✅ | ✅ |
| CLI cancellation + stuck-child cleanup | ✅ | ✅ | ✅ |
| HTTP transport (loopback + bearer) | ✅ | ✅ | ✅ |
| Codex installer | ✅ | ✅ | ✅ |
| Claude Code installer | ✅ | ✅ | ✅ |

## MCP clients

| Feature | Codex | Claude Code | Notes |
| --- | --- | --- | --- |
| stdio server (`serve`) | ✅ | ✅ | Recommended default |
| Stable tool catalog | ✅ | ✅ | Unavailable backends yield structured errors, not missing tools |
| `run_turn` progress | ✅ (request progress) | ✅ (request progress) | Coalesced, request-scoped notifications |
| Cancellation | ✅ | ✅ | `notifications/cancelled` aborts the backend |
| Resources | ✅ | ✅ | Throttled update notifications |
| `startup_timeout_sec` / `tool_timeout_sec` | ✅ via installer | n/a | Codex config.toml only |
| `claude mcp add` / `.mcp.json` | n/a | ✅ via installer | user + project scope |

## Backends

| Feature | Desktop | CLI (PTY) | SDK |
| --- | --- | --- | --- |
| Read projects/threads/messages | ✅ | history only | Not enabled |
| Writes (send/stop/resume/model/effort) | ✅ when authorized | ✅ | Not enabled |
| Live progress | ✅ SSE | coarse PTY output events | Not enabled |
| Structured events | ✅ | partial | Not enabled |

The programmatic Codebuff/Freebuff SDK backend (`sdk`) is **not enabled**: the current upstream SDK requires an API key that normal Freebuff users do not have, and no supported local authenticated integration is exposed. Per the security rules, the bridge does not extract credentials to enable it. The adapter architecture keeps a slot for it (`FreebuffBackend.kind: 'sdk'`) should upstream expose a supported contract.

## Protocol adapters

| Adapter | Command | Status |
| --- | --- | --- |
| MCP v2 | `serve` | Stable, primary |
| MCP v1 | `serve-v1` | Legacy compatibility |
| HTTP (Streamable) | `serve-http` | Supported, local-first |
| ACP v1 | `serve-acp` | Experimental |

Every adapter runs on the same canonical discovery, SSE client, and bounded event store; none of them duplicate Desktop discovery or event handling. `serve-v1` exposes the legacy tool names (`get_thread_progress_summary`, `watch_active_threads`, …) on top of that shared layer, and `serve` additionally exposes `get_thread_progress_summary` and `get_diff`.

## Not supported

- Remote HTTP without explicit `FREEBUFF_MCP_ALLOW_REMOTE=1` (and HTTPS in front).
- Writing to a Desktop thread without its launch-ID health check passing.
- Passing bridge-generated ids to Freebuff `--continue`.
- Reasoning/thought content in tool output (dropped at the adapter layer).

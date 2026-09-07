# Compatibility

| Capability | Status in this build |
| --- | --- |
| Node.js runtime | Node 20 or newer |
| MCP stdio | Implemented |
| Desktop dynamic `/api/*` discovery | Readiness metadata, platform logs, and native listener fallback |
| Projects, threads, visible messages | Implemented and live verified |
| Safe project file reads | Implemented; shallow file listing and bounded reads |
| Model, stop, resume writes | Tool definitions present, blocked by current Desktop authorization |
| Attachments | Not yet implemented |
| Authenticated Streamable HTTP relay | Implemented, loopback by default |
| Cloudflare deployment | Not included, requires deployment credentials and an HTTPS tunnel |
| CLI PTY and local chat history | Implemented; CLI writes require the managed PTY |
| Live Freebuff Desktop write verification | `/healthz` launch-ID handshake; otherwise read-only |


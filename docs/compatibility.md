# Compatibility

| Capability | Status in this build |
| --- | --- |
| Node.js runtime | Node 20 or newer |
| MCP stdio | Implemented |
| Desktop dynamic `/api/*` discovery | Platform-aware log discovery implemented; Windows live verified |
| Projects, threads, visible messages | Implemented and live verified |
| Safe project file reads | Implemented; shallow file listing and bounded reads |
| Model, stop, resume writes | Tool definitions present, blocked by current Desktop authorization |
| Attachments | Not yet implemented |
| Authenticated Streamable HTTP relay | Implemented, loopback by default |
| Cloudflare deployment | Not included, requires deployment credentials and an HTTPS tunnel |
| CLI PTY and local chat history | Implemented; CLI writes require the managed PTY |
| Live Freebuff Desktop write verification | Read-only until the app's launch authorization contract is documented and verified |


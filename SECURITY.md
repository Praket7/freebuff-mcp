# Security policy

Please report security issues privately to the repository maintainers. Do not include credentials, tokens, cookies, or private source code in an issue.

The bridge binds to localhost when an HTTP adapter is added. The current release uses stdio and local HTTP requests only. Freebuff credentials are never returned, logged, or sent to a relay.


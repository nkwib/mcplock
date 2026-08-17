# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-11

### Added

- Streamable HTTP transport (MCP revision 2025-06-18), so remote servers can be pinned. POSTs single JSON-RPC messages to one MCP endpoint, accepts both `application/json` and SSE-framed responses, carries `Mcp-Session-Id` and `MCP-Protocol-Version` per the spec, re-initializes and replays when a session expires with a 404, and terminates the session with `DELETE` on teardown (405 is treated as success). Zero runtime dependencies: global `fetch` and a hand-written SSE decoder.
- Config entries accept `{ "url": "https://...", "headers": { ... } }` alongside `{ "command", "args", "env" }`, in the same `mcpServers` map. `"type": "http"` is honoured; `"type": "sse"` (the deprecated 2024-11-05 transport) is rejected with an explanatory error.
- `${VAR}` expansion in config `headers`, so a committed config can reference a secret without containing one. An unset variable is a hard error.
- `--url <url>` and repeatable `--header "Name: value"` for the ad-hoc CLI form, alongside the existing `--` form for local servers.
- `verify` treats a changed URL, and a changed transport, exactly as it already treated a changed command: drift, even when the tool definitions match byte for byte.
- Exports: `StreamableHttpMcpClient`, `SseDecoder`, `collectTools`, `normalizeUrl`, `isHttpSpec`, `PROTOCOL_VERSION`, `LOCKFILE_VERSION`, and the `StdioServerSpec` / `HttpServerSpec` / `LockedStdioServer` / `LockedHttpServer` types.
- CHANGELOG.

### Changed

- **Lockfile version 2.** Server entries gain a `transport` discriminator (`"stdio"` or `"http"`), and HTTP entries record `url` instead of `command`/`args`. Version 1 lockfiles are migrated on read (every v1 entry was stdio), so `verify` keeps working against an existing `mcp.lock` after upgrading; the next `lock` rewrites it at version 2. An unrecognised version is a hard error.
- `ServerDriftReport.command` is now `ServerDriftReport.endpoint`, which reports the command line for stdio servers and the URL for HTTP ones. `command` remains as a deprecated alias carrying the same value for 0.1.x `--json` consumers, and will be removed in 0.3.
- `ServerDriftReport` gains `transport`, and `lock --json` reports the transport per server.
- `ServerSpec` is now a union of `StdioServerSpec` and `HttpServerSpec`. Existing `{ name, command, args }` values keep type checking unchanged.
- Redirects on the HTTP transport are refused rather than followed: a 3xx means the definitions came from an endpoint other than the pinned one. The error names the `Location` header.
- URLs with embedded credentials are rejected, because the URL is recorded in a committed lockfile.
- `tools/list` pagination now refuses to follow a repeated cursor, instead of paging forever against a broken server.

### Fixed

- Malformed JSON in a lockfile or a config file now produces an `McpLockError` with the parse position, rather than a raw `SyntaxError` stack.

## [0.1.0] - 2026-08-11

### Added

- Initial release: lockfile-gated integrity pinning for MCP tool definitions over the stdio transport, `lock` and `verify` commands, per-tool and per-server SHA-256 hashes over the canonicalized definition, exact drift paths, and a `verify` that flags a swapped server command even when the definitions match.

[Unreleased]: https://github.com/nkwib/mcplock/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nkwib/mcplock/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nkwib/mcplock/releases/tag/v0.1.0

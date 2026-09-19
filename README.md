# mcplock

[![CI](https://github.com/nkwib/mcplock/actions/workflows/ci.yml/badge.svg)](https://github.com/nkwib/mcplock/actions/workflows/ci.yml)

Lockfile-gated integrity pinning for MCP tool definitions. Hash them once, approve them once, fail CI when a server swaps them.

## Why

MCP clients show you a tool's name, description, and schema at approval time. Nothing guarantees those definitions stay what you approved: a server can silently swap a description or schema afterwards, turning an approved tool into an injection vector (the "rug-pull", [CVE-2025-54136](https://nvd.nist.gov/vuln/detail/CVE-2025-54136)). The [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) recommends pinning tool definitions by hash. mcplock is that pin: scanners audit, mcplock gates.

## Quickstart

```bash
# 1. Pin the servers you approved (reads the common .mcp.json shape)
npx @nkwib/mcplock lock --config .mcp.json

# 2. Review and commit the lockfile
git add mcp.lock && git commit -m "pin mcp tool definitions"

# 3. Gate on drift (CI, pre-commit, or before every session)
npx @nkwib/mcplock verify --config .mcp.json
```

`verify` exits 1 the moment any pinned server adds, removes, or mutates a tool definition, and tells you exactly which field moved:

```
✗ docs-server: DRIFT
    changed: search
      description
```

One-off servers work without a config file, local after `--` and remote with `--url`:

```bash
npx @nkwib/mcplock lock --name docs -- npx -y @example/docs-mcp-server
npx @nkwib/mcplock verify --name docs -- npx -y @example/docs-mcp-server

npx @nkwib/mcplock lock --name deepwiki --url https://mcp.deepwiki.com/mcp
npx @nkwib/mcplock verify --name deepwiki --url https://mcp.deepwiki.com/mcp
```

## Transports

Local servers over stdio and remote servers over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). Both go in the same `{ "mcpServers": { ... } }` config, side by side:

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["-y", "@example/docs-mcp-server"]
    },
    "deepwiki": {
      "url": "https://mcp.deepwiki.com/mcp"
    },
    "internal": {
      "type": "http",
      "url": "https://mcp.internal.example/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

An entry is HTTP when it has a `url` (or `"type": "http"`), stdio when it has a `command`. `headers` are sent on every request, expanded from the environment with `${VAR}` so a committed config can reference a secret without containing one, and are never hashed or written to the lockfile. Credentials in the URL itself (`https://user:token@host/mcp`) are rejected: the URL goes into a committed lockfile.

Two deliberate strictnesses on the HTTP side:

- **Redirects are refused, not followed.** A 3xx means the tool definitions would come from somewhere other than the URL you pinned. mcplock reports the `Location` and asks you to point the config at the final URL.
- **The URL is compared byte for byte**, exactly as the command line is. Cosmetic edits to a pinned URL are drift.

### GitHub Actions

```yaml
- name: Verify MCP tool definitions
  run: npx @nkwib/mcplock verify --config .mcp.json
```

## What gets hashed

Per tool: `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, canonicalized (keys sorted, `undefined` dropped) and hashed with WebCrypto SHA-256. Per server, a root hash over the sorted per-tool hashes.

Descriptions are included deliberately. They are the primary poisoning vector: model-facing prose that changes behavior without touching any schema. A pin that skips descriptions gates nothing.

`verify` also compares the endpoint it was pointed at against the one recorded in the lockfile: the command line for stdio, the URL for HTTP. Tool definitions are only meaningful if they came from the endpoint you approved, so swapping the command or the URL behind a pinned server name is reported as drift even when the replacement advertises byte-identical tools. Changing the transport of a pinned server is drift for the same reason.

## Lockfile format

`mcp.lock` is pretty-printed JSON containing the full canonicalized definition next to each hash, so drift shows up in PR review as a readable diff, not just a changed digest:

```json
{
  "version": 2,
  "generatedAt": "2026-08-11T09:00:00.000Z",
  "servers": {
    "docs-server": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@example/docs-mcp-server"],
      "rootHash": "3f1c…",
      "tools": {
        "search": {
          "hash": "9b2e…",
          "definition": {
            "description": "Search the docs index",
            "inputSchema": { "…": "…" },
            "name": "search"
          }
        }
      }
    },
    "deepwiki": {
      "transport": "http",
      "url": "https://mcp.deepwiki.com/mcp",
      "rootHash": "357f…",
      "tools": { "…": "…" }
    }
  }
}
```

Version 2 adds the `transport` discriminator and the `url` field. Version 1 lockfiles are migrated on read (every v1 entry was stdio, so `command`/`args` map over losslessly): `verify` keeps working against an existing `mcp.lock` after upgrading, and the next `lock` rewrites it at version 2. An unrecognised version is a hard error, not a silent pass.

## CLI

Installed as a dev dependency (`npm i -D @nkwib/mcplock`), the binary is `mcplock`:

```
mcplock <lock|verify> [options] [-- <command> [args...]]

--config <path>       Read servers from a { "mcpServers": { ... } } config file
--server <name>       Only lock/verify this server from the config
--url <url>           Ad-hoc remote server over Streamable HTTP
--header "K: V"       Extra header for --url (repeatable, e.g. Authorization)
--name <label>        Server name for the ad-hoc (--url or --) form (default: "default")
--timeout <ms>        Per-request timeout (default: 10000)
--lockfile <path>     Lockfile path (default: ./mcp.lock)
--json                Machine-readable output
```

| Exit code | Meaning |
| --------- | ------- |
| 0 | Definitions match the lockfile |
| 1 | Drift detected (swapped command or URL, or added, removed, or changed tools) |
| 2 | Operational error (spawn failure, unreachable endpoint, timeout, missing lockfile, bad flags) |

## Library

```ts
import { lockServers, verifyServers } from '@nkwib/mcplock';

const lock = await lockServers([{ name: 'docs', command: 'npx', args: ['-y', '@example/docs-mcp-server'] }]);
const result = await verifyServers(lock, servers);
// result.reports[0].changed -> [{ tool: 'search', paths: ['description'] }]
```

Remote servers use the same call with a `url`:

```ts
const lock = await lockServers([{ name: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }]);
```

Also exported: `canonicalize`, `canonicalJson`, `hashToolDefinition`, `rootHash`, `sha256Hex`, `diffPaths`, `fetchTools`, `collectTools`, `StdioMcpClient`, `StreamableHttpMcpClient`, `SseDecoder`, `normalizeUrl`, `isHttpSpec`, `PROTOCOL_VERSION`, `LOCKFILE_VERSION`, and the `LockFile` / `ServerSpec` / `VerifyResult` types.

## Protocol revision

mcplock speaks the handshake-based MCP revision **2025-06-18**: `initialize`, `notifications/initialized`, `tools/list`, plus the `Mcp-Session-Id` and `MCP-Protocol-Version` headers on Streamable HTTP. It accepts whatever version the server counter-offers during negotiation and echoes that back on later requests, so 2025-03-26 and 2025-11-25 servers work too.

Revision [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog) is a breaking redesign (no `initialize` handshake, no session header, protocol version carried in `_meta`) and is **not** supported yet. A server on that revision answers `initialize` with a method-not-found error, and mcplock says so explicitly rather than failing obscurely.

## Scope and limitations

- Pins tools only; prompts and resources surfaces are planned.
- Streamable HTTP only for remote servers. The deprecated 2024-11-05 HTTP+SSE transport (`"type": "sse"`) is rejected with a clear message rather than silently probed for.
- The standalone `GET` SSE stream and `Last-Event-ID` resumability are not implemented: pinning needs one request/response pair, not a long-lived stream.
- `env` values from the config are passed to the spawned server but are not part of the hash. Neither are `headers`.
- Zero runtime dependencies, Node >= 18 (the HTTP transport uses global `fetch`).

### What the HTTP transport was and was not validated against

The test suite drives a fixture HTTP server written in this repo, which proves the client agrees with an implementation written by the same author. That is worth less than it looks, so the transport was also run against real public remote MCP servers. Confirmed live: SSE-framed responses, session id issuance and echo, protocol version negotiation including a downgrade to 2025-03-26, `DELETE` answered with 405 and treated as a clean teardown, a 401 surfaced as a readable error, and a redirect refused (a trailing slash on one endpoint redirects to plain `http://`, which is exactly the case for not following).

Still only fixture-tested, not confirmed against a real server: `application/json` response framing (every public server tried chose SSE), session expiry returning 404 and the re-initialize-and-replay path that follows, `tools/list` cursor pagination over HTTP, and authenticated servers reached through `headers`.

## Releasing

1. Bump the version in `package.json` and add a section to `CHANGELOG.md`.
2. Tag the release commit `vX.Y.Z` and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` builds, tests, checks the tag against `package.json`, and publishes to npm with provenance.

One-time setup on npmjs.com: add a Trusted Publisher on the `@nkwib/mcplock` package with publisher `GitHub Actions`, repository `nkwib/mcplock`, and workflow `release.yml`.

MIT

# mcplock

[![CI](https://github.com/nkwib/mcplock/actions/workflows/ci.yml/badge.svg)](https://github.com/nkwib/mcplock/actions/workflows/ci.yml)

Lockfile-gated integrity pinning for MCP tool definitions. Hash them once, approve them once, fail CI when a server swaps them.

## Why

MCP clients show you a tool's name, description, and schema at approval time. Nothing guarantees those definitions stay what you approved: a server can silently swap a description or schema afterwards, turning an approved tool into an injection vector (the "rug-pull", [CVE-2025-54136](https://nvd.nist.gov/vuln/detail/CVE-2025-54136)). The [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) recommends pinning tool definitions by hash. mcplock is that pin: scanners audit, mcplock gates.

## Quickstart

```bash
# 1. Pin the servers you approved (reads the common .mcp.json shape)
npx mcplock lock --config .mcp.json

# 2. Review and commit the lockfile
git add mcp.lock && git commit -m "pin mcp tool definitions"

# 3. Gate on drift (CI, pre-commit, or before every session)
npx mcplock verify --config .mcp.json
```

`verify` exits 1 the moment any pinned server adds, removes, or mutates a tool definition, and tells you exactly which field moved:

```
✗ docs-server: DRIFT
    changed: search
      description
```

One-off servers work without a config file:

```bash
npx mcplock lock --name docs -- npx -y @example/docs-mcp-server
npx mcplock verify --name docs -- npx -y @example/docs-mcp-server
```

### GitHub Actions

```yaml
- name: Verify MCP tool definitions
  run: npx mcplock verify --config .mcp.json
```

## What gets hashed

Per tool: `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, canonicalized (keys sorted, `undefined` dropped) and hashed with WebCrypto SHA-256. Per server, a root hash over the sorted per-tool hashes.

Descriptions are included deliberately. They are the primary poisoning vector: model-facing prose that changes behavior without touching any schema. A pin that skips descriptions gates nothing.

## Lockfile format

`mcp.lock` is pretty-printed JSON containing the full canonicalized definition next to each hash, so drift shows up in PR review as a readable diff, not just a changed digest:

```json
{
  "version": 1,
  "generatedAt": "2026-08-11T09:00:00.000Z",
  "servers": {
    "docs-server": {
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
    }
  }
}
```

## CLI

```
mcplock <lock|verify> [options] [-- <command> [args...]]

--config <path>    Read servers from a { "mcpServers": { ... } } config file
--server <name>    Only lock/verify this server from the config
--name <label>     Server name for the ad-hoc (--) form (default: "default")
--timeout <ms>     Per-request timeout (default: 10000)
--lockfile <path>  Lockfile path (default: ./mcp.lock)
--json             Machine-readable output
```

| Exit code | Meaning |
| --------- | ------- |
| 0 | Definitions match the lockfile |
| 1 | Drift detected (added, removed, or changed tools) |
| 2 | Operational error (spawn failure, timeout, missing lockfile, bad flags) |

## Library

```ts
import { lockServers, verifyServers } from 'mcplock';

const lock = await lockServers([{ name: 'docs', command: 'npx', args: ['-y', '@example/docs-mcp-server'] }]);
const result = await verifyServers(lock, servers);
// result.reports[0].changed -> [{ tool: 'search', paths: ['description'] }]
```

Also exported: `canonicalize`, `canonicalJson`, `hashToolDefinition`, `rootHash`, `sha256Hex`, `diffPaths`, `fetchTools`, `StdioMcpClient`, and the `LockFile` / `ServerSpec` / `VerifyResult` types.

## Scope and limitations

- Stdio transport only for now; HTTP/SSE servers are the next slice.
- Pins tools only; prompts and resources surfaces are planned.
- `env` values from the config are passed to the spawned server but are not part of the hash.
- Zero runtime dependencies, Node >= 18.

MIT

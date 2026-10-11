# Security Policy

## Reporting a vulnerability

Report privately through GitHub: open the **Security** tab on this repository and use **Report a vulnerability**. Please do not open a public issue for a security problem.

You should get an acknowledgement within 7 days. If the report is accepted, the fix ships in a new release and the advisory is published with credit to you unless you ask otherwise. If it is declined, you get the reasoning and are free to disclose.

## Scope

In scope: lockfile generation, hashing, and verification of MCP tool definitions

Out of scope: the `docs-site/` directory and anything under `examples/`, which are not published and are not part of the supported surface. Denial of service through deliberately malformed input to a local developer tool is also out of scope unless it escalates beyond the calling process.

## Supported versions

`@nkwib/mcplock` is pre-1.0. Only the latest version published on npm receives security fixes. There are no maintained release branches.

## Release integrity

Releases are published by `.github/workflows/release.yml` on a `v*` tag through npm Trusted Publishing. There is no long-lived npm token in this repository, and every published version carries an npm provenance attestation linking it to the exact commit and workflow run that built it.

Verify what you installed:

```bash
npm audit signatures
```

/**
 * The tool surface that gets pinned. Exactly these fields, no more: they are
 * what a client shows a user at approval time and what a poisoned server
 * mutates afterwards. Descriptions are included deliberately, they are the
 * documented injection vector.
 */
export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/** A local MCP server spawned as a child process, framed over stdio. */
export interface StdioServerSpec {
  name: string;
  transport?: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** A remote MCP server reached over the Streamable HTTP transport. */
export interface HttpServerSpec {
  name: string;
  transport?: 'http';
  url: string;
  /** Extra request headers, e.g. `{ Authorization: "Bearer ..." }`. Never hashed, never written to the lockfile. */
  headers?: Record<string, string>;
}

export type ServerSpec = StdioServerSpec | HttpServerSpec;

export function isHttpSpec(spec: ServerSpec): spec is HttpServerSpec {
  return typeof (spec as HttpServerSpec).url === 'string';
}

export interface LockedTool {
  hash: string;
  definition: ToolDefinition;
}

/** Lockfile entry for a stdio server: the endpoint identity is the argv. */
export interface LockedStdioServer {
  transport: 'stdio';
  command: string;
  args: string[];
  rootHash: string;
  tools: Record<string, LockedTool>;
}

/** Lockfile entry for a remote server: the endpoint identity is the URL. */
export interface LockedHttpServer {
  transport: 'http';
  url: string;
  rootHash: string;
  tools: Record<string, LockedTool>;
}

export type LockedServer = LockedStdioServer | LockedHttpServer;

export const LOCKFILE_VERSION = 2;

export interface LockFile {
  version: typeof LOCKFILE_VERSION;
  generatedAt: string;
  servers: Record<string, LockedServer>;
}

export interface ChangedTool {
  tool: string;
  /** Dot paths into the definition that differ, e.g. "description" or "inputSchema.properties.query.type". */
  paths: string[];
}

/**
 * The pinned server was reached through a different endpoint than the one
 * locked: a different command line for stdio, a different URL for HTTP.
 */
export interface EndpointDrift {
  locked: string;
  live: string;
}

/** @deprecated Use `EndpointDrift`. Kept as an alias for 0.1.x consumers. */
export type CommandDrift = EndpointDrift;

export interface ServerDriftReport {
  server: string;
  transport: 'stdio' | 'http';
  /** Endpoint identity drift: the locked argv or URL no longer matches the live one. */
  endpoint: EndpointDrift | null;
  /** @deprecated Alias of `endpoint`, kept for 0.1.x `--json` consumers. Removed in 0.3. */
  command: EndpointDrift | null;
  added: string[];
  removed: string[];
  changed: ChangedTool[];
  clean: boolean;
}

export interface VerifyResult {
  clean: boolean;
  reports: ServerDriftReport[];
}

export class McpLockError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'McpLockError';
  }
}

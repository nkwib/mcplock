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

export interface ServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface LockedTool {
  hash: string;
  definition: ToolDefinition;
}

export interface LockedServer {
  command: string;
  args: string[];
  rootHash: string;
  tools: Record<string, LockedTool>;
}

export interface LockFile {
  version: 1;
  generatedAt: string;
  servers: Record<string, LockedServer>;
}

export interface ChangedTool {
  tool: string;
  /** Dot paths into the definition that differ, e.g. "description" or "inputSchema.properties.query.type". */
  paths: string[];
}

/** The pinned server was reached through a different command than the one locked. */
export interface CommandDrift {
  locked: string;
  live: string;
}

export interface ServerDriftReport {
  server: string;
  command: CommandDrift | null;
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

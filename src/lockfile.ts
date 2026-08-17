import { canonicalize } from './canonicalize';
import { hashToolDefinition, rootHash } from './hash';
import { normalizeUrl } from './http';
import { fetchTools } from './rpc';
import {
  isHttpSpec,
  LOCKFILE_VERSION,
  McpLockError,
  type ChangedTool,
  type LockFile,
  type LockedServer,
  type LockedTool,
  type ServerDriftReport,
  type ServerSpec,
  type ToolDefinition,
  type VerifyResult,
} from './types';

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The endpoint a pinned server name resolves to. Definitions are only
 * trustworthy if they came from the endpoint that was approved, so this is
 * pinned alongside the tools and compared byte for byte on verify.
 */
interface Endpoint {
  transport: 'stdio' | 'http';
  identity: string;
}

function specEndpoint(spec: ServerSpec): Endpoint {
  if (isHttpSpec(spec)) return { transport: 'http', identity: normalizeUrl(spec.url, spec.name) };
  return { transport: 'stdio', identity: [spec.command, ...spec.args].join(' ') };
}

function lockedEndpoint(locked: LockedServer): Endpoint {
  return locked.transport === 'http'
    ? { transport: 'http', identity: locked.url }
    : { transport: 'stdio', identity: [locked.command, ...locked.args].join(' ') };
}

async function lockOneServer(spec: ServerSpec, timeoutMs: number): Promise<LockedServer> {
  const endpoint = specEndpoint(spec);
  const tools = await fetchTools(spec, timeoutMs);
  const locked: Record<string, LockedTool> = {};
  const hashes: string[] = [];
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const definition = canonicalize(tool) as ToolDefinition;
    const hash = await hashToolDefinition(definition);
    locked[tool.name] = { hash, definition };
    hashes.push(hash);
  }
  const root = await rootHash(hashes);
  if (isHttpSpec(spec)) {
    return { transport: 'http', url: endpoint.identity, rootHash: root, tools: locked };
  }
  return { transport: 'stdio', command: spec.command, args: spec.args, rootHash: root, tools: locked };
}

/** Connect to every server, list tools, and produce a lockfile object. */
export async function lockServers(
  servers: ServerSpec[],
  options: { timeoutMs?: number } = {},
): Promise<LockFile> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locked: Record<string, LockedServer> = {};
  for (const spec of servers) {
    locked[spec.name] = await lockOneServer(spec, timeoutMs);
  }
  return { version: LOCKFILE_VERSION, generatedAt: new Date().toISOString(), servers: locked };
}

/** Leaf-level dot paths where two canonicalized values differ. */
export function diffPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (Object.is(a, b)) return [];
  const isObjA = a !== null && typeof a === 'object';
  const isObjB = b !== null && typeof b === 'object';
  if (!isObjA || !isObjB || Array.isArray(a) !== Array.isArray(b)) {
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    return [prefix || '(root)'];
  }
  const keys = new Set([
    ...Object.keys(a as Record<string, unknown>),
    ...Object.keys(b as Record<string, unknown>),
  ]);
  const paths: string[] = [];
  for (const key of [...keys].sort()) {
    const nextPrefix = Array.isArray(a) ? `${prefix}[${key}]` : prefix ? `${prefix}.${key}` : key;
    paths.push(
      ...diffPaths(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        nextPrefix,
      ),
    );
  }
  return paths;
}

async function verifyOneServer(
  name: string,
  locked: LockedServer,
  spec: ServerSpec,
  timeoutMs: number,
): Promise<ServerDriftReport> {
  // The tools are only trustworthy if they came from the endpoint that was
  // approved: swapping the command or the URL behind a pinned server name is
  // itself drift, even when the replacement advertises identical definitions.
  const lockedEnd = lockedEndpoint(locked);
  const liveEnd = specEndpoint(spec);
  // Only qualify with the transport name when the transport itself changed,
  // so the common same-transport report stays terse.
  const qualify = lockedEnd.transport !== liveEnd.transport;
  const label = (e: Endpoint) => (qualify ? `${e.transport}: ${e.identity}` : e.identity);
  const sameEndpoint = !qualify && lockedEnd.identity === liveEnd.identity;
  const endpoint = sameEndpoint ? null : { locked: label(lockedEnd), live: label(liveEnd) };

  const live = await fetchTools(spec, timeoutMs);
  const liveByName = new Map(live.map((t) => [t.name, canonicalize(t) as ToolDefinition]));

  const added = [...liveByName.keys()].filter((n) => !(n in locked.tools)).sort();
  const removed = Object.keys(locked.tools)
    .filter((n) => !liveByName.has(n))
    .sort();

  const changed: ChangedTool[] = [];
  for (const [toolName, entry] of Object.entries(locked.tools).sort(([a], [b]) => a.localeCompare(b))) {
    const liveDef = liveByName.get(toolName);
    if (!liveDef) continue;
    const liveHash = await hashToolDefinition(liveDef);
    if (liveHash !== entry.hash) {
      changed.push({ tool: toolName, paths: diffPaths(entry.definition, liveDef) });
    }
  }

  const clean =
    endpoint === null && added.length === 0 && removed.length === 0 && changed.length === 0;
  return {
    server: name,
    transport: liveEnd.transport,
    endpoint,
    command: endpoint,
    added,
    removed,
    changed,
    clean,
  };
}

/** Recompute live tool definitions and compare them against the lockfile. */
export async function verifyServers(
  lock: LockFile,
  servers: ServerSpec[],
  options: { timeoutMs?: number } = {},
): Promise<VerifyResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reports: ServerDriftReport[] = [];
  for (const spec of servers) {
    const locked = lock.servers[spec.name];
    if (!locked) {
      reports.push({
        server: spec.name,
        transport: specEndpoint(spec).transport,
        endpoint: null,
        command: null,
        added: ['(server missing from lockfile)'],
        removed: [],
        changed: [],
        clean: false,
      });
      continue;
    }
    reports.push(await verifyOneServer(spec.name, locked, spec, timeoutMs));
  }
  return { clean: reports.every((r) => r.clean), reports };
}

export function serializeLockFile(lock: LockFile): string {
  return JSON.stringify(lock, null, 2) + '\n';
}

interface LockFileV1 {
  version: 1;
  generatedAt: string;
  servers: Record<string, { command: string; args: string[]; rootHash: string; tools: Record<string, LockedTool> }>;
}

/**
 * Version 1 predates HTTP: every entry was a stdio server recorded as
 * `command`/`args`, so the upgrade is lossless and applied on read. `mcplock
 * lock` rewrites the file at version 2.
 */
function migrateV1(v1: LockFileV1): LockFile {
  const servers: Record<string, LockedServer> = {};
  for (const [name, entry] of Object.entries(v1.servers)) {
    if (typeof entry?.command !== 'string' || !Array.isArray(entry.args)) {
      throw new McpLockError(`malformed mcp.lock: version 1 server "${name}" has no command/args to migrate`);
    }
    servers[name] = {
      transport: 'stdio',
      command: entry.command,
      args: entry.args,
      rootHash: entry.rootHash,
      tools: entry.tools,
    };
  }
  return { version: LOCKFILE_VERSION, generatedAt: v1.generatedAt, servers };
}

export function parseLockFile(raw: string): LockFile {
  let parsed: { version?: unknown; servers?: unknown };
  try {
    parsed = JSON.parse(raw) as LockFile;
  } catch (err) {
    throw new McpLockError(`malformed mcp.lock: ${(err as Error).message}`);
  }
  if (typeof parsed.servers !== 'object' || parsed.servers === null) {
    throw new McpLockError('malformed mcp.lock: missing a "servers" object');
  }
  if (parsed.version === 1) return migrateV1(parsed as unknown as LockFileV1);
  if (parsed.version !== LOCKFILE_VERSION) {
    throw new McpLockError(
      `unsupported mcp.lock version ${String(parsed.version)}: this mcplock reads versions 1 and ${LOCKFILE_VERSION}, upgrade mcplock or re-run \`mcplock lock\``,
    );
  }
  return parsed as unknown as LockFile;
}

import { canonicalize } from './canonicalize';
import { hashToolDefinition, rootHash } from './hash';
import { fetchTools } from './rpc';
import type {
  ChangedTool,
  LockFile,
  LockedServer,
  ServerDriftReport,
  ServerSpec,
  ToolDefinition,
  VerifyResult,
} from './types';

export const DEFAULT_TIMEOUT_MS = 10_000;

async function lockOneServer(spec: ServerSpec, timeoutMs: number): Promise<LockedServer> {
  const tools = await fetchTools(spec, timeoutMs);
  const locked: Record<string, { hash: string; definition: ToolDefinition }> = {};
  const hashes: string[] = [];
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const definition = canonicalize(tool) as ToolDefinition;
    const hash = await hashToolDefinition(definition);
    locked[tool.name] = { hash, definition };
    hashes.push(hash);
  }
  return { command: spec.command, args: spec.args, rootHash: await rootHash(hashes), tools: locked };
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
  return { version: 1, generatedAt: new Date().toISOString(), servers: locked };
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

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

async function verifyOneServer(
  name: string,
  locked: LockedServer,
  spec: ServerSpec,
  timeoutMs: number,
): Promise<ServerDriftReport> {
  // The tools are only trustworthy if they came from the binary that was
  // approved: swapping the command behind a pinned server name is itself drift,
  // even when the replacement advertises identical definitions.
  const lockedCommand = formatCommand(locked.command, locked.args);
  const liveCommand = formatCommand(spec.command, spec.args);
  const command =
    lockedCommand === liveCommand ? null : { locked: lockedCommand, live: liveCommand };

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
    command === null && added.length === 0 && removed.length === 0 && changed.length === 0;
  return { server: name, command, added, removed, changed, clean };
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

export function parseLockFile(raw: string): LockFile {
  const parsed = JSON.parse(raw) as LockFile;
  if (parsed.version !== 1 || typeof parsed.servers !== 'object' || parsed.servers === null) {
    throw new Error('unsupported or malformed mcp.lock (expected version 1)');
  }
  return parsed;
}

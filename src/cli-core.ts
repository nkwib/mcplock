import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_TIMEOUT_MS, lockServers, parseLockFile, serializeLockFile, verifyServers } from './lockfile';
import { McpLockError, type ServerSpec, type VerifyResult } from './types';

interface CliIo {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface ParsedArgs {
  command: 'lock' | 'verify';
  config?: string;
  server?: string;
  name: string;
  timeoutMs: number;
  json: boolean;
  lockfile: string;
  url?: string;
  headers: Record<string, string>;
  adhoc?: { command: string; args: string[] };
}

const USAGE = `mcplock <lock|verify> [options] [-- <command> [args...]]

Options:
  --config <path>       Read servers from a { "mcpServers": { ... } } config file
  --server <name>       Only lock/verify this server from the config
  --url <url>           Ad-hoc remote server over Streamable HTTP
  --header "K: V"       Extra header for --url (repeatable, e.g. Authorization)
  --name <label>        Server name for the ad-hoc (--url or --) form (default: "default")
  --timeout <ms>        Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --lockfile <path>     Lockfile path (default: ./mcp.lock)
  --json                Machine-readable output

Ad-hoc servers: a local one after --, a remote one with --url.

Exit codes: 0 clean, 1 drift detected, 2 operational error`;

export function parseArgs(argv: string[]): ParsedArgs {
  const sep = argv.indexOf('--');
  const flags = sep >= 0 ? argv.slice(0, sep) : argv;
  const rest = sep >= 0 ? argv.slice(sep + 1) : [];

  const command = flags[0];
  if (command !== 'lock' && command !== 'verify') {
    throw new McpLockError(`expected a command (lock or verify)\n\n${USAGE}`);
  }

  const parsed: ParsedArgs = {
    command,
    name: 'default',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    lockfile: 'mcp.lock',
    headers: {},
  };

  for (let i = 1; i < flags.length; i++) {
    const flag = flags[i];
    const next = () => {
      const value = flags[++i];
      if (value === undefined) throw new McpLockError(`missing value for ${flag}`);
      return value;
    };
    switch (flag) {
      case '--config':
        parsed.config = next();
        break;
      case '--server':
        parsed.server = next();
        break;
      case '--url':
        parsed.url = next();
        break;
      case '--header': {
        const raw = next();
        const colon = raw.indexOf(':');
        if (colon <= 0) throw new McpLockError(`--header expects "Name: value", got: ${raw}`);
        parsed.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
        break;
      }
      case '--name':
        parsed.name = next();
        break;
      case '--timeout': {
        const ms = Number(next());
        if (!Number.isFinite(ms) || ms <= 0) throw new McpLockError('--timeout expects a positive number of milliseconds');
        parsed.timeoutMs = ms;
        break;
      }
      case '--lockfile':
        parsed.lockfile = next();
        break;
      case '--json':
        parsed.json = true;
        break;
      default:
        throw new McpLockError(`unknown flag: ${flag}\n\n${USAGE}`);
    }
  }

  if (rest.length > 0) {
    const [cmd, ...args] = rest;
    if (!cmd) throw new McpLockError('empty command after --');
    parsed.adhoc = { command: cmd, args };
  }
  if (parsed.adhoc && parsed.url) {
    throw new McpLockError('pass either --url or a command after --, not both');
  }
  if (Object.keys(parsed.headers).length > 0 && !parsed.url) {
    throw new McpLockError('--header only applies to --url');
  }
  return parsed;
}

interface ConfigEntry {
  type?: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface ConfigShape {
  mcpServers?: Record<string, ConfigEntry>;
}

/**
 * Expand `${VAR}` in a header value so a committed config can reference a
 * secret without containing it. An unset variable is a hard error: silently
 * sending `Bearer ${TOKEN}` would produce a confusing 401 instead.
 */
function expandEnv(value: string, env: Record<string, string | undefined>, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new McpLockError(`${where} references \${${name}} but that environment variable is not set`);
    }
    return resolved;
  });
}

function specFromConfigEntry(
  name: string,
  entry: ConfigEntry,
  configPath: string,
  env: Record<string, string | undefined>,
): ServerSpec {
  const declared = entry.type ?? entry.transport;
  if (declared === 'sse') {
    throw new McpLockError(
      `server "${name}" in ${configPath} uses the deprecated HTTP+SSE transport; mcplock speaks Streamable HTTP, set "type": "http"`,
    );
  }
  if (declared !== undefined && declared !== 'http' && declared !== 'stdio' && declared !== 'streamable-http') {
    throw new McpLockError(`server "${name}" in ${configPath} has unknown type "${declared}"`);
  }
  const wantsHttp = declared === 'http' || declared === 'streamable-http' || (declared === undefined && entry.url !== undefined);

  if (entry.command !== undefined && entry.url !== undefined) {
    throw new McpLockError(`server "${name}" in ${configPath} sets both command and url; pick one transport`);
  }
  if (wantsHttp) {
    if (typeof entry.url !== 'string' || entry.url === '') {
      throw new McpLockError(`server "${name}" in ${configPath} has no url`);
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.headers ?? {})) {
      headers[key] = expandEnv(String(value), env, `header "${key}" of server "${name}" in ${configPath}`);
    }
    return { name, transport: 'http', url: entry.url, headers };
  }
  if (typeof entry.command !== 'string') {
    throw new McpLockError(`server "${name}" in ${configPath} has no command or url`);
  }
  return { name, transport: 'stdio', command: entry.command, args: entry.args ?? [], env: entry.env };
}

async function resolveServers(
  parsed: ParsedArgs,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<ServerSpec[]> {
  if (parsed.url) {
    return [{ name: parsed.name, transport: 'http', url: parsed.url, headers: parsed.headers }];
  }
  if (parsed.adhoc) {
    return [{ name: parsed.name, transport: 'stdio', command: parsed.adhoc.command, args: parsed.adhoc.args }];
  }
  if (!parsed.config) {
    throw new McpLockError('no servers given: pass --config <path>, --url <url>, or an ad-hoc command after --');
  }
  let raw: string;
  try {
    raw = await readFile(resolve(cwd, parsed.config), 'utf8');
  } catch (err) {
    throw new McpLockError(`cannot read config ${parsed.config}: ${(err as Error).message}`);
  }
  let config: ConfigShape;
  try {
    config = JSON.parse(raw) as ConfigShape;
  } catch (err) {
    throw new McpLockError(`cannot parse config ${parsed.config}: ${(err as Error).message}`);
  }
  const entries = Object.entries(config.mcpServers ?? {});
  if (entries.length === 0) throw new McpLockError(`no mcpServers entries in ${parsed.config}`);
  const servers: ServerSpec[] = [];
  for (const [name, entry] of entries) {
    if (parsed.server && name !== parsed.server) continue;
    servers.push(specFromConfigEntry(name, entry, parsed.config, env));
  }
  if (servers.length === 0) throw new McpLockError(`server "${parsed.server}" not found in ${parsed.config}`);
  return servers;
}

function formatReport(result: VerifyResult): string {
  const lines: string[] = [];
  for (const report of result.reports) {
    if (report.clean) {
      lines.push(`✓ ${report.server}: clean`);
      continue;
    }
    lines.push(`✗ ${report.server}: DRIFT`);
    if (report.endpoint) {
      lines.push(`    endpoint: ${report.endpoint.locked}`);
      lines.push(`          ->  ${report.endpoint.live}`);
    }
    for (const name of report.added) lines.push(`    added:   ${name}`);
    for (const name of report.removed) lines.push(`    removed: ${name}`);
    for (const change of report.changed) {
      lines.push(`    changed: ${change.tool}`);
      for (const path of change.paths) lines.push(`      ${path}`);
    }
  }
  return lines.join('\n');
}

/** Runs the CLI. Returns the process exit code instead of exiting. */
export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? ((line: string) => console.log(line));
  const stderr = io.stderr ?? ((line: string) => console.error(line));

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr((err as Error).message);
    return 2;
  }

  try {
    const servers = await resolveServers(parsed, cwd, env);
    const lockfilePath = resolve(cwd, parsed.lockfile);

    if (parsed.command === 'lock') {
      const lock = await lockServers(servers, { timeoutMs: parsed.timeoutMs });
      await writeFile(lockfilePath, serializeLockFile(lock), 'utf8');
      if (parsed.json) {
        stdout(JSON.stringify({ written: parsed.lockfile, servers: Object.fromEntries(Object.entries(lock.servers).map(([n, s]) => [n, { transport: s.transport, rootHash: s.rootHash, tools: Object.keys(s.tools).length }])) }));
      } else {
        for (const [name, server] of Object.entries(lock.servers)) {
          stdout(`✓ ${name}: locked ${Object.keys(server.tools).length} tool(s) over ${server.transport}, root ${server.rootHash.slice(0, 12)}…`);
        }
        stdout(`wrote ${parsed.lockfile}`);
      }
      return 0;
    }

    let lockRaw: string;
    try {
      lockRaw = await readFile(lockfilePath, 'utf8');
    } catch {
      stderr(`no lockfile at ${parsed.lockfile}: run \`mcplock lock\` first`);
      return 2;
    }
    const lock = parseLockFile(lockRaw);
    const result = await verifyServers(lock, servers, { timeoutMs: parsed.timeoutMs });
    stdout(parsed.json ? JSON.stringify(result) : formatReport(result));
    return result.clean ? 0 : 1;
  } catch (err) {
    stderr(err instanceof McpLockError ? err.message : `unexpected error: ${(err as Error).stack ?? err}`);
    return 2;
  }
}

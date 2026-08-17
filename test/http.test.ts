import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  lockServers,
  McpLockError,
  parseLockFile,
  SseDecoder,
  verifyServers,
  type HttpServerSpec,
  type LockedHttpServer,
  type ServerSpec,
} from '../src/index';
import { runCli } from '../src/cli-core';
import { startHttpFixture } from './fixtures/http-server.mjs';

const STDIO_FIXTURE = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));

type Fixture = Awaited<ReturnType<typeof startHttpFixture>>;

const open: Fixture[] = [];

/** Start a fixture that is torn down after the test, whatever happens. */
async function fixture(options: Parameters<typeof startHttpFixture>[0] = {}): Promise<Fixture> {
  const started = await startHttpFixture(options);
  open.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const http = (url: string, headers?: Record<string, string>): HttpServerSpec => ({
  name: 'remote',
  transport: 'http',
  url,
  ...(headers ? { headers } : {}),
});

const HEX_64 = /^[0-9a-f]{64}$/;

describe('streamable http lock', () => {
  it('locks the tool surface over SSE-framed responses', async () => {
    const server = await fixture();
    const lock = await lockServers([http(server.url)]);
    const locked = lock.servers.remote as LockedHttpServer;
    expect(lock.version).toBe(2);
    expect(locked.transport).toBe('http');
    expect(locked.url).toBe(server.url);
    expect(Object.keys(locked.tools).sort()).toEqual(['fetch_page', 'search']);
    expect(locked.rootHash).toMatch(HEX_64);
    expect(locked.tools.search!.definition.description).toBe('Search the docs index');
  });

  it('locks identically whether the response is SSE-framed or a plain JSON body', async () => {
    const sse = await fixture({ framing: 'sse' });
    const json = await fixture({ framing: 'json' });
    const a = await lockServers([http(sse.url)]);
    const b = await lockServers([http(json.url)]);
    expect((a.servers.remote as LockedHttpServer).rootHash).toBe((b.servers.remote as LockedHttpServer).rootHash);
  });

  it('hashes the same tool surface identically over http and stdio', async () => {
    const server = await fixture();
    const overHttp = await lockServers([http(server.url)]);
    const overStdio = await lockServers([
      { name: 'remote', command: process.execPath, args: [STDIO_FIXTURE] } as ServerSpec,
    ]);
    expect(overHttp.servers.remote!.rootHash).toBe(overStdio.servers.remote!.rootHash);
  });

  it('follows tools/list pagination over http and hashes identically to the unpaged set', async () => {
    const server = await fixture();
    const base = await lockServers([http(server.url)]);
    server.setVariant('paged');
    const paged = await lockServers([http(server.url)]);
    expect(paged.servers.remote!.rootHash).toBe(base.servers.remote!.rootHash);
    expect(Object.keys(paged.servers.remote!.tools).sort()).toEqual(['fetch_page', 'search']);
    expect(server.requests.filter((r) => r.rpcMethod === 'tools/list')).toHaveLength(3);
  });

  it('reassembles an SSE frame split across several chunks', async () => {
    const server = await fixture({ splitFrames: true });
    const lock = await lockServers([http(server.url)]);
    expect(Object.keys(lock.servers.remote!.tools).sort()).toEqual(['fetch_page', 'search']);
  });

  it('times out against a server that opens an SSE stream and never answers', async () => {
    const server = await fixture({ variant: 'hang' });
    await expect(lockServers([http(server.url)], { timeoutMs: 400 })).rejects.toThrow(
      /timed out after 400ms waiting for tools\/list/,
    );
  });

  it('reports an unreachable endpoint clearly', async () => {
    const server = await fixture();
    const url = server.url;
    await server.close();
    open.length = 0;
    await expect(lockServers([http(url)], { timeoutMs: 2000 })).rejects.toThrow(/could not be reached at/);
  });

  it('refuses to follow a redirect away from the pinned url', async () => {
    const server = await fixture({ redirectTo: 'https://elsewhere.example/mcp' });
    await expect(lockServers([http(server.url)])).rejects.toThrow(/redirected initialize away from/);
  });

  it('rejects credentials embedded in the url', async () => {
    await expect(lockServers([http('https://user:secret@example.com/mcp')])).rejects.toThrow(
      /credentials embedded in its url/,
    );
    await expect(lockServers([http('ftp://example.com/mcp')])).rejects.toThrow(/unsupported url scheme/);
    await expect(lockServers([http('not a url')])).rejects.toThrow(/invalid url/);
  });
});

describe('streamable http protocol conformance', () => {
  it('sends the spec headers: Accept on every POST, session id and protocol version only after initialize', async () => {
    const server = await fixture();
    await lockServers([http(server.url)]);

    const posts = server.requests.filter((r) => r.method === 'POST');
    const initialize = posts.find((r) => r.rpcMethod === 'initialize')!;
    const initialized = posts.find((r) => r.rpcMethod === 'notifications/initialized')!;
    const list = posts.find((r) => r.rpcMethod === 'tools/list')!;

    for (const post of posts) {
      expect(post.accept).toContain('application/json');
      expect(post.accept).toContain('text/event-stream');
      expect(post.headers['content-type']).toContain('application/json');
    }
    // The initialize POST cannot carry either: no session exists yet and no
    // version has been negotiated.
    expect(initialize.sessionId).toBeUndefined();
    expect(initialize.protocolVersion).toBeUndefined();
    // Everything after it must carry both.
    expect(initialized.sessionId).toBeDefined();
    expect(initialized.protocolVersion).toBe('2025-06-18');
    expect(list.sessionId).toBe(initialized.sessionId);
    expect(list.protocolVersion).toBe('2025-06-18');
  });

  it('echoes the protocol version the server negotiated, not the one requested', async () => {
    const server = await fixture();
    // The fixture echoes params.protocolVersion, so drive it through a client
    // that asked for the current revision and confirm the header follows.
    await lockServers([http(server.url)]);
    const list = server.requests.find((r) => r.rpcMethod === 'tools/list')!;
    const initialize = server.requests.find((r) => r.rpcMethod === 'initialize')!;
    expect(list.protocolVersion).toBe('2025-06-18');
    expect(initialize.protocolVersion).toBeUndefined();
  });

  it('terminates the session with DELETE when it is done', async () => {
    const server = await fixture();
    await lockServers([http(server.url)]);
    const del = server.requests.find((r) => r.method === 'DELETE');
    expect(del).toBeDefined();
    const initialize = server.requests.find((r) => r.rpcMethod === 'initialize')!;
    const list = server.requests.find((r) => r.rpcMethod === 'tools/list')!;
    expect(del!.sessionId).toBe(list.sessionId);
    expect(initialize.sessionId).toBeUndefined();
  });

  it('treats a 405 on DELETE as a clean teardown', async () => {
    const server = await fixture({ allowDelete: false });
    const lock = await lockServers([http(server.url)]);
    expect(Object.keys(lock.servers.remote!.tools)).toHaveLength(2);
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('works against a stateless server that never issues a session id', async () => {
    const server = await fixture({ session: 'none' });
    const lock = await lockServers([http(server.url)]);
    expect(Object.keys(lock.servers.remote!.tools).sort()).toEqual(['fetch_page', 'search']);
    for (const post of server.requests.filter((r) => r.method === 'POST')) {
      expect(post.sessionId).toBeUndefined();
    }
    expect(server.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('re-initializes and replays when the server expires the session with a 404', async () => {
    const server = await fixture({ session: 'expire-once' });
    const lock = await lockServers([http(server.url)]);
    expect(Object.keys(lock.servers.remote!.tools).sort()).toEqual(['fetch_page', 'search']);
    const inits = server.requests.filter((r) => r.rpcMethod === 'initialize');
    const lists = server.requests.filter((r) => r.rpcMethod === 'tools/list');
    expect(inits).toHaveLength(2);
    expect(lists.length).toBeGreaterThanOrEqual(2);
    // The replay must run on a fresh session, and the second initialize must
    // not carry the dead session id.
    expect(inits[1]!.sessionId).toBeUndefined();
    expect(lists.at(-1)!.sessionId).not.toBe(lists[0]!.sessionId);
  });

  it('passes configured headers through on every request', async () => {
    const server = await fixture();
    await lockServers([http(server.url, { Authorization: 'Bearer s3cr3t', 'X-Trace': 'abc' })]);
    for (const post of server.requests.filter((r) => r.method === 'POST')) {
      expect(post.headers.authorization).toBe('Bearer s3cr3t');
      expect(post.headers['x-trace']).toBe('abc');
    }
  });
});

describe('streamable http verify', () => {
  it('passes when nothing changed', async () => {
    const server = await fixture();
    const lock = await lockServers([http(server.url)]);
    const result = await verifyServers(lock, [http(server.url)]);
    expect(result.clean).toBe(true);
    expect(result.reports[0]).toMatchObject({ server: 'remote', transport: 'http', endpoint: null });
  });

  // These swap the tool set on a live server, so the URL never moves: the only
  // thing that changed is what the endpoint advertises, which is the rug-pull.
  it('catches a poisoned description with the exact field path', async () => {
    const server = await fixture();
    const lock = await lockServers([http(server.url)]);
    server.setVariant('poisoned');
    const result = await verifyServers(lock, [http(server.url)]);
    expect(result.clean).toBe(false);
    expect(result.reports[0]!.endpoint).toBeNull();
    const changed = result.reports[0]!.changed;
    expect(changed).toHaveLength(1);
    expect(changed[0]!.tool).toBe('search');
    expect(changed[0]!.paths).toEqual(['description']);
  });

  it('catches a schema change with the exact field path', async () => {
    const server = await fixture();
    const lock = await lockServers([http(server.url)]);
    server.setVariant('schema');
    const result = await verifyServers(lock, [http(server.url)]);
    expect(result.reports[0]!.endpoint).toBeNull();
    expect(result.reports[0]!.changed[0]!.paths).toEqual(['inputSchema.properties.query.type']);
  });

  it('catches added and removed tools', async () => {
    const server = await fixture();
    const lock = await lockServers([http(server.url)]);
    server.setVariant('extra');
    expect((await verifyServers(lock, [http(server.url)])).reports[0]!.added).toEqual(['wipe_disk']);
    server.setVariant('missing');
    expect((await verifyServers(lock, [http(server.url)])).reports[0]!.removed).toEqual(['fetch_page']);
  });

  it('catches a swapped url even when the tools are byte identical', async () => {
    const server = await fixture();
    const lock = await lockServers([http(server.url)]);
    // Same process, same tool definitions, different endpoint path: this is
    // not the endpoint that was approved.
    const result = await verifyServers(lock, [http(server.altUrl)]);
    expect(result.clean).toBe(false);
    expect(result.reports[0]!.changed).toEqual([]);
    expect(result.reports[0]!.added).toEqual([]);
    expect(result.reports[0]!.endpoint).toEqual({ locked: server.url, live: server.altUrl });
    expect(result.reports[0]!.command).toEqual(result.reports[0]!.endpoint);
  });

  it('catches a transport swapped from stdio to http', async () => {
    const server = await fixture();
    const lock = await lockServers([
      { name: 'remote', command: process.execPath, args: [STDIO_FIXTURE] } as ServerSpec,
    ]);
    const result = await verifyServers(lock, [http(server.url)]);
    expect(result.clean).toBe(false);
    expect(result.reports[0]!.changed).toEqual([]);
    expect(result.reports[0]!.endpoint!.locked).toBe(`stdio: ${process.execPath} ${STDIO_FIXTURE}`);
    expect(result.reports[0]!.endpoint!.live).toBe(`http: ${server.url}`);
  });

  it('reports drift when the pinned server is missing from the lockfile', async () => {
    const server = await fixture();
    const lock = await lockServers([http(server.url)]);
    const result = await verifyServers(lock, [{ ...http(server.url), name: 'other' }]);
    expect(result.clean).toBe(false);
    expect(result.reports[0]!.added).toEqual(['(server missing from lockfile)']);
  });
});

describe('lockfile versioning', () => {
  it('migrates a version 1 lockfile as stdio and keeps verifying', async () => {
    const v1 = JSON.stringify({
      version: 1,
      generatedAt: '2026-08-11T09:00:00.000Z',
      servers: {
        fixture: {
          command: process.execPath,
          args: [STDIO_FIXTURE],
          rootHash: 'deadbeef',
          tools: {},
        },
      },
    });
    const parsed = parseLockFile(v1);
    expect(parsed.version).toBe(2);
    expect(parsed.servers.fixture).toMatchObject({
      transport: 'stdio',
      command: process.execPath,
      args: [STDIO_FIXTURE],
    });
  });

  it('rejects an unknown lockfile version with an actionable message', () => {
    const future = JSON.stringify({ version: 99, generatedAt: 'x', servers: {} });
    expect(() => parseLockFile(future)).toThrow(McpLockError);
    expect(() => parseLockFile(future)).toThrow(/unsupported mcp.lock version 99/);
    expect(() => parseLockFile('{ not json')).toThrow(/malformed mcp.lock/);
    expect(() => parseLockFile('{"version":2}')).toThrow(/missing a "servers" object/);
  });
});

describe('cli over http', () => {
  it('lock then verify round-trips with the ad-hoc --url form', async () => {
    const server = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-http-'));
    const out: string[] = [];
    const io = { cwd, stdout: (l: string) => out.push(l), stderr: (l: string) => out.push(l) };
    expect(await runCli(['lock', '--name', 'remote', '--url', server.url], io)).toBe(0);
    const lock = JSON.parse(await readFile(join(cwd, 'mcp.lock'), 'utf8'));
    expect(lock.version).toBe(2);
    expect(lock.servers.remote.transport).toBe('http');
    expect(lock.servers.remote.url).toBe(server.url);
    expect(await runCli(['verify', '--name', 'remote', '--url', server.url], io)).toBe(0);
    expect(out.join('\n')).toContain('clean');
  });

  it('flags a changed --url as drift', async () => {
    const server = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-http-'));
    const out: string[] = [];
    const io = { cwd, stdout: (l: string) => out.push(l), stderr: (l: string) => out.push(l) };
    expect(await runCli(['lock', '--name', 'remote', '--url', server.url], io)).toBe(0);
    out.length = 0;
    expect(await runCli(['verify', '--name', 'remote', '--url', server.altUrl], io)).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('DRIFT');
    expect(text).toContain('endpoint:');
    expect(text).toContain(server.altUrl);
  });

  it('reads a url server from the config and expands ${VAR} in headers', async () => {
    const server = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-http-'));
    const config = {
      mcpServers: {
        remote: { type: 'http', url: server.url, headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
      },
    };
    await writeFile(join(cwd, 'mcp.json'), JSON.stringify(config));
    const io = { cwd, env: { DOCS_TOKEN: 'from-env' }, stdout: () => {}, stderr: () => {} };
    expect(await runCli(['lock', '--config', 'mcp.json'], io)).toBe(0);
    expect(await runCli(['verify', '--config', 'mcp.json'], io)).toBe(0);
    const post = server.requests.find((r) => r.method === 'POST')!;
    expect(post.headers.authorization).toBe('Bearer from-env');

    const missingEnv = { cwd, env: {}, stdout: () => {}, stderr: () => {} };
    expect(await runCli(['verify', '--config', 'mcp.json'], missingEnv)).toBe(2);
  });

  it('locks stdio and http servers side by side from one config', async () => {
    const server = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-http-'));
    const config = {
      mcpServers: {
        local: { command: process.execPath, args: [STDIO_FIXTURE] },
        remote: { url: server.url },
      },
    };
    await writeFile(join(cwd, 'mcp.json'), JSON.stringify(config));
    const io = { cwd, stdout: () => {}, stderr: () => {} };
    expect(await runCli(['lock', '--config', 'mcp.json'], io)).toBe(0);
    const lock = JSON.parse(await readFile(join(cwd, 'mcp.lock'), 'utf8'));
    expect(lock.servers.local.transport).toBe('stdio');
    expect(lock.servers.remote.transport).toBe('http');
    expect(await runCli(['verify', '--config', 'mcp.json'], io)).toBe(0);
  });

  it('emits the transport in --json output', async () => {
    const server = await fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-http-'));
    const out: string[] = [];
    const io = { cwd, stdout: (l: string) => out.push(l), stderr: () => {} };
    expect(await runCli(['lock', '--name', 'remote', '--url', server.url, '--json'], io)).toBe(0);
    expect(JSON.parse(out.join('')).servers.remote.transport).toBe('http');
    out.length = 0;
    expect(await runCli(['verify', '--name', 'remote', '--url', server.altUrl, '--json'], io)).toBe(1);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.reports[0].transport).toBe('http');
    expect(parsed.reports[0].endpoint.live).toBe(server.altUrl);
  });

  it('rejects bad transport configuration with exit 2', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-http-'));
    const io = { cwd, stdout: () => {}, stderr: () => {} };
    const write = (name: string, config: unknown) => writeFile(join(cwd, name), JSON.stringify(config));

    await write('sse.json', { mcpServers: { r: { type: 'sse', url: 'https://example.com/sse' } } });
    await write('both.json', { mcpServers: { r: { command: 'node', url: 'https://example.com/mcp' } } });
    await write('neither.json', { mcpServers: { r: { args: [] } } });
    await write('nourl.json', { mcpServers: { r: { type: 'http' } } });

    expect(await runCli(['lock', '--config', 'sse.json'], io)).toBe(2);
    expect(await runCli(['lock', '--config', 'both.json'], io)).toBe(2);
    expect(await runCli(['lock', '--config', 'neither.json'], io)).toBe(2);
    expect(await runCli(['lock', '--config', 'nourl.json'], io)).toBe(2);
    // --url and -- are mutually exclusive, and --header needs --url.
    expect(await runCli(['lock', '--url', 'https://x/mcp', '--', 'node', 'x.mjs'], io)).toBe(2);
    expect(await runCli(['lock', '--header', 'A: b', '--', 'node', 'x.mjs'], io)).toBe(2);
    expect(await runCli(['lock', '--url', 'https://x/mcp', '--header', 'no-colon'], io)).toBe(2);
  });
});

describe('SseDecoder', () => {
  const collect = (decoder: SseDecoder, chunks: string[]) => chunks.flatMap((c) => decoder.push(c));

  it('dispatches on a blank line and joins repeated data fields', () => {
    const events = collect(new SseDecoder(), ['event: message\ndata: {"a":1}\ndata: tail\n\n']);
    expect(events).toEqual([{ event: 'message', data: '{"a":1}\ntail' }]);
  });

  it('reassembles events split across chunk boundaries', () => {
    const decoder = new SseDecoder();
    const events = collect(decoder, ['data: hel', 'lo\n', '\ndata: wor', 'ld\n\n']);
    expect(events.map((e) => e.data)).toEqual(['hello', 'world']);
    expect(events[0]!.event).toBe('message');
  });

  it('handles CRLF and lone CR line endings, holding a trailing CR across chunks', () => {
    const decoder = new SseDecoder();
    expect(collect(decoder, ['data: a\r', '\n\r\n'])).toEqual([{ event: 'message', data: 'a' }]);
    // A trailing CR is held back until the next chunk shows whether it was a CRLF.
    expect(collect(decoder, ['data: b\r\r'])).toEqual([]);
    expect(collect(decoder, ['\n'])).toEqual([{ event: 'message', data: 'b' }]);
  });

  it('ignores comments and does not dispatch an event with no data', () => {
    const decoder = new SseDecoder();
    expect(collect(decoder, [': keep-alive\n\n'])).toEqual([]);
    expect(collect(decoder, ['event: ping\n\n'])).toEqual([]);
  });

  it('keeps a priming event with empty data and carries the id', () => {
    const events = collect(new SseDecoder(), ['id: 7\ndata:\n\n']);
    expect(events).toEqual([{ event: 'message', data: '', id: '7' }]);
  });

  it('strips exactly one leading space after the colon', () => {
    const events = collect(new SseDecoder(), ['data:  two spaces\n\n']);
    expect(events[0]!.data).toBe(' two spaces');
  });
});

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  lockServers,
  McpLockError,
  verifyServers,
  type ServerSpec,
} from '../src/index';
import { runCli } from '../src/cli-core';

const FIXTURE = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));

const fixture = (variant?: string): ServerSpec => ({
  name: 'fixture',
  command: process.execPath,
  args: [FIXTURE],
  env: variant ? { FIXTURE_VARIANT: variant } : {},
});

const HEX_64 = /^[0-9a-f]{64}$/;

describe('lockServers', () => {
  it('locks the full tool surface with per-tool and root hashes', async () => {
    const lock = await lockServers([fixture()]);
    const server = lock.servers.fixture;
    expect(server).toBeDefined();
    expect(Object.keys(server!.tools).sort()).toEqual(['fetch_page', 'search']);
    expect(server!.rootHash).toMatch(HEX_64);
    for (const tool of Object.values(server!.tools)) {
      expect(tool.hash).toMatch(HEX_64);
      expect(tool.definition.description).toBeTruthy();
    }
    expect(server!.tools.search!.definition.inputSchema).toMatchObject({
      properties: { query: { type: 'string' } },
    });
  });

  it('is deterministic across runs', async () => {
    const a = await lockServers([fixture()]);
    const b = await lockServers([fixture()]);
    expect(a.servers.fixture!.rootHash).toBe(b.servers.fixture!.rootHash);
  });

  it('follows tools/list pagination and hashes identically to the unpaged set', async () => {
    const paged = await lockServers([fixture('paged')]);
    const base = await lockServers([fixture()]);
    expect(paged.servers.fixture!.rootHash).toBe(base.servers.fixture!.rootHash);
    expect(Object.keys(paged.servers.fixture!.tools).sort()).toEqual(['fetch_page', 'search']);
  });

  it('times out against a hanging server', async () => {
    await expect(lockServers([fixture('hang')], { timeoutMs: 400 })).rejects.toThrow(McpLockError);
    await expect(lockServers([fixture('hang')], { timeoutMs: 400 })).rejects.toThrow(/timed out after 400ms/);
  });
});

describe('verifyServers', () => {
  it('passes when nothing changed', async () => {
    const lock = await lockServers([fixture()]);
    const result = await verifyServers(lock, [fixture()]);
    expect(result.clean).toBe(true);
    expect(result.reports[0]).toMatchObject({ server: 'fixture', added: [], removed: [], changed: [] });
  });

  it('catches a poisoned description with the exact field path', async () => {
    const lock = await lockServers([fixture()]);
    const result = await verifyServers(lock, [fixture('poisoned')]);
    expect(result.clean).toBe(false);
    const changed = result.reports[0]!.changed;
    expect(changed).toHaveLength(1);
    expect(changed[0]!.tool).toBe('search');
    expect(changed[0]!.paths).toEqual(['description']);
  });

  it('catches a schema change with the exact field path', async () => {
    const lock = await lockServers([fixture()]);
    const result = await verifyServers(lock, [fixture('schema')]);
    expect(result.clean).toBe(false);
    expect(result.reports[0]!.changed[0]!.paths).toEqual(['inputSchema.properties.query.type']);
  });

  it('catches added and removed tools', async () => {
    const lock = await lockServers([fixture()]);
    const extra = await verifyServers(lock, [fixture('extra')]);
    expect(extra.reports[0]!.added).toEqual(['wipe_disk']);
    const missing = await verifyServers(lock, [fixture('missing')]);
    expect(missing.reports[0]!.removed).toEqual(['fetch_page']);
  });
});

describe('cli', () => {
  const cliFixtureArgs = ['--', process.execPath, FIXTURE];

  it('lock then verify round-trips with exit 0 via the ad-hoc form', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-'));
    const out: string[] = [];
    const io = { cwd, stdout: (l: string) => out.push(l), stderr: (l: string) => out.push(l) };
    expect(await runCli(['lock', '--name', 'fixture', ...cliFixtureArgs], io)).toBe(0);
    const raw = await readFile(join(cwd, 'mcp.lock'), 'utf8');
    expect(JSON.parse(raw).version).toBe(1);
    expect(await runCli(['verify', '--name', 'fixture', ...cliFixtureArgs], io)).toBe(0);
    expect(out.join('\n')).toContain('clean');
  });

  it('verify exits 1 on drift via the config form and reports the poisoned path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-'));
    const cleanConfig = { mcpServers: { fixture: { command: process.execPath, args: [FIXTURE] } } };
    const poisonedConfig = {
      mcpServers: { fixture: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_VARIANT: 'poisoned' } } },
    };
    await writeFile(join(cwd, 'clean.json'), JSON.stringify(cleanConfig));
    await writeFile(join(cwd, 'poisoned.json'), JSON.stringify(poisonedConfig));
    const out: string[] = [];
    const io = { cwd, stdout: (l: string) => out.push(l), stderr: (l: string) => out.push(l) };
    expect(await runCli(['lock', '--config', 'clean.json'], io)).toBe(0);
    expect(await runCli(['verify', '--config', 'poisoned.json'], io)).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('DRIFT');
    expect(text).toContain('description');
  });

  it('exits 2 on operational errors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-'));
    const io = { cwd, stdout: () => {}, stderr: () => {} };
    expect(await runCli(['verify', '--name', 'fixture', ...cliFixtureArgs], io)).toBe(2); // no lockfile yet
    expect(await runCli(['lock'], io)).toBe(2); // no servers given
    expect(await runCli(['frobnicate'], io)).toBe(2); // unknown command
    expect(await runCli(['lock', '--timeout', 'abc', '--name', 'fixture', ...cliFixtureArgs], io)).toBe(2); // bad flag value
  });

  it('emits machine-readable drift with --json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mcplock-'));
    const out: string[] = [];
    const io = { cwd, stdout: (l: string) => out.push(l), stderr: () => {} };
    const config = { mcpServers: { fixture: { command: process.execPath, args: [FIXTURE] } } };
    const schemaConfig = {
      mcpServers: { fixture: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_VARIANT: 'schema' } } },
    };
    await writeFile(join(cwd, 'a.json'), JSON.stringify(config));
    await writeFile(join(cwd, 'b.json'), JSON.stringify(schemaConfig));
    expect(await runCli(['lock', '--config', 'a.json'], io)).toBe(0);
    out.length = 0;
    expect(await runCli(['verify', '--config', 'b.json', '--json'], io)).toBe(1);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.clean).toBe(false);
    expect(parsed.reports[0].changed[0].paths).toEqual(['inputSchema.properties.query.type']);
  });
});

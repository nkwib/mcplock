#!/usr/bin/env node
// CI smoke test for the built CLI over the Streamable HTTP transport: start the
// fixture, lock it, verify it clean, then rug-pull the tool set and expect
// exit 1. Mirrors the stdio smoke test in .github/workflows/ci.yml.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpFixture } from './http-server.mjs';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const server = await startHttpFixture();
const cwd = await mkdtemp(join(tmpdir(), 'mcplock-smoke-'));
let failures = 0;

const expect = (label, actual, wanted) => {
  const ok = actual === wanted;
  console.log(`${ok ? 'ok' : 'FAIL'} ${label} (exit ${actual}, expected ${wanted})`);
  if (!ok) failures++;
};

expect('lock over http', await run(['lock', '--name', 'remote', '--url', server.url], cwd), 0);
expect('verify clean', await run(['verify', '--name', 'remote', '--url', server.url], cwd), 0);

server.setVariant('poisoned');
expect('verify poisoned', await run(['verify', '--name', 'remote', '--url', server.url], cwd), 1);

server.setVariant('base');
expect('verify swapped url', await run(['verify', '--name', 'remote', '--url', server.altUrl], cwd), 1);

await server.close();
process.exit(failures === 0 ? 0 : 1);

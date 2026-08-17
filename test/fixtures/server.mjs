#!/usr/bin/env node
// Zero-dependency fixture MCP server speaking JSON-RPC 2.0 over stdio
// (newline-delimited). Tool set is controlled by FIXTURE_VARIANT to simulate
// rug-pull drift: base | poisoned | schema | extra | missing | paged | hang.
import { createInterface } from 'node:readline';
import { pagedResult, toolsFor } from './tools.mjs';

const variant = process.env.FIXTURE_VARIANT ?? 'base';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    if (variant === 'hang') return; // never answer: exercises the client timeout
    if (variant === 'paged') {
      send({ jsonrpc: '2.0', id: msg.id, result: pagedResult(msg.params?.cursor) });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: toolsFor(variant) } });
    return;
  }
  if (typeof msg.id === 'number') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});

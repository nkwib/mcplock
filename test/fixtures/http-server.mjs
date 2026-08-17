#!/usr/bin/env node
// Zero-dependency fixture MCP server speaking the Streamable HTTP transport
// (revision 2025-06-18): a single MCP endpoint that takes POSTed JSON-RPC
// messages and answers with either application/json or SSE frames.
//
// It serves the same tool surface and the same drift variants as the stdio
// fixture, and it enforces the parts of the spec a client is required to get
// right: the Accept header, the Mcp-Session-Id lifecycle, and the
// MCP-Protocol-Version header on post-initialize requests.
//
// https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pagedResult, toolsFor } from './tools.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const MCP_PATHS = new Set(['/mcp', '/mcp-alt']);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function jsonRpcError(res, id, code, message, headers = {}) {
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } }, headers);
}

/**
 * Start the fixture.
 *
 * @param {object} [options]
 * @param {string} [options.variant]     base | poisoned | schema | extra | missing | paged | hang
 * @param {'sse'|'json'} [options.framing]  How responses to requests are framed (default sse).
 * @param {'required'|'none'|'expire-once'} [options.session]
 *        required: issue a session id and reject later requests that omit it.
 *        none: stateless, never issue one.
 *        expire-once: issue one, then 404 the first tools/list to force a re-initialize.
 * @param {boolean} [options.requireProtocolHeader] 400 post-initialize requests that omit MCP-Protocol-Version (default true).
 * @param {boolean} [options.allowDelete] Answer DELETE with 204 rather than 405 (default true).
 * @param {boolean} [options.splitFrames] Write SSE frames in slices with gaps, to exercise incremental parsing.
 * @param {string}  [options.redirectTo]  Answer every POST with a 307 to this location.
 */
export async function startHttpFixture(options = {}) {
  const {
    variant = 'base',
    framing = 'sse',
    session: sessionMode = 'required',
    requireProtocolHeader = true,
    allowDelete = true,
    splitFrames = false,
    redirectTo,
  } = options;

  const sessions = new Set();
  const requests = [];
  let currentVariant = variant;
  let expired = false;
  let eventId = 0;

  async function writeSse(res, message, extraHeaders) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...extraHeaders,
    });
    // A comment (keep-alive), then a priming event with empty data, then an
    // unrelated server notification, then the actual response. A conforming
    // client has to skip the first three and still find the fourth.
    res.write(': keep-alive\n\n');
    res.write(`id: ${++eventId}\ndata: \n\n`);
    res.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing tools' } })}\n\n`,
    );
    const frame = `event: message\nid: ${++eventId}\ndata: ${JSON.stringify(message)}\n\n`;
    if (splitFrames) {
      const cut = Math.floor(frame.length / 3);
      res.write(frame.slice(0, cut));
      await delay(5);
      res.write(frame.slice(cut, cut * 2));
      await delay(5);
      res.write(frame.slice(cut * 2));
    } else {
      res.write(frame);
    }
    res.end();
  }

  async function respond(res, message, extraHeaders = {}) {
    if (framing === 'json') {
      sendJson(res, 200, message, extraHeaders);
      return;
    }
    await writeSse(res, message, extraHeaders);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!MCP_PATHS.has(url.pathname)) {
      sendJson(res, 404, { error: 'not an mcp endpoint' });
      return;
    }

    if (req.method === 'GET') {
      // The spec lets a server decline the standalone SSE stream with 405.
      requests.push({ method: 'GET', path: url.pathname, headers: req.headers });
      res.writeHead(405).end();
      return;
    }

    if (req.method === 'DELETE') {
      const id = req.headers['mcp-session-id'];
      requests.push({ method: 'DELETE', path: url.pathname, headers: req.headers, sessionId: id });
      if (!allowDelete) {
        res.writeHead(405).end();
        return;
      }
      if (typeof id === 'string') sessions.delete(id);
      res.writeHead(204).end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const raw = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } });
      return;
    }
    const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
    requests.push({
      method: 'POST',
      path: url.pathname,
      rpcMethod: msg.method,
      headers: req.headers,
      sessionId,
      accept: req.headers.accept,
      protocolVersion: req.headers['mcp-protocol-version'],
    });

    if (redirectTo) {
      res.writeHead(307, { location: redirectTo }).end();
      return;
    }

    // "The client MUST include an Accept header, listing both application/json
    // and text/event-stream as supported content types."
    const accept = req.headers.accept ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      sendJson(res, 406, { error: `bad Accept header: ${accept}` });
      return;
    }

    if (msg.method === 'initialize') {
      const headers = {};
      if (sessionMode !== 'none') {
        const id = randomUUID();
        sessions.add(id);
        headers['Mcp-Session-Id'] = id;
      }
      await respond(
        res,
        {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'http-fixture', version: '1.0.0' },
          },
        },
        headers,
      );
      return;
    }

    // Everything past initialize must carry the session id (when one was
    // issued) and the negotiated protocol version.
    if (sessionMode !== 'none') {
      if (sessionId === undefined) {
        sendJson(res, 400, { error: 'missing Mcp-Session-Id' });
        return;
      }
      if (!sessions.has(sessionId)) {
        sendJson(res, 404, { error: 'unknown or terminated session' });
        return;
      }
    } else if (sessionId !== undefined) {
      sendJson(res, 400, { error: 'this server is stateless and issued no session id' });
      return;
    }
    if (requireProtocolHeader && req.headers['mcp-protocol-version'] === undefined) {
      sendJson(res, 400, { error: 'missing MCP-Protocol-Version' });
      return;
    }

    if (msg.id === undefined) {
      // A notification: 202 Accepted with no body.
      res.writeHead(202).end();
      return;
    }

    if (msg.method === 'tools/list') {
      if (sessionMode === 'expire-once' && !expired) {
        // Terminate the session mid-flight: the client must re-initialize and replay.
        expired = true;
        if (sessionId !== undefined) sessions.delete(sessionId);
        sendJson(res, 404, { error: 'session expired' });
        return;
      }
      if (currentVariant === 'hang') {
        // Headers only, never a response: exercises the client timeout.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': keep-alive\n\n');
        return;
      }
      const result =
        currentVariant === 'paged' ? pagedResult(msg.params?.cursor) : { tools: toolsFor(currentVariant) };
      await respond(res, { jsonrpc: '2.0', id: msg.id, result });
      return;
    }

    jsonRpcError(res, msg.id, -32601, `method not found: ${msg.method}`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    altUrl: `http://127.0.0.1:${port}/mcp-alt`,
    requests,
    /** Swap the advertised tool set while the endpoint stays put: a live rug-pull. */
    setVariant(next) {
      currentVariant = next;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Standalone mode, for smoke tests: FIXTURE_VARIANT picks the drift variant.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await startHttpFixture({ variant: process.env.FIXTURE_VARIANT ?? 'base' });
  console.log(fixture.url);
}

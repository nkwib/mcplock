import { CLIENT_INFO, PROTOCOL_VERSION, type McpTransport } from './mcp';
import { SseDecoder, type SseEvent } from './sse';
import { McpLockError, type HttpServerSpec } from './types';

/**
 * Client for the MCP Streamable HTTP transport, revision 2025-06-18.
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 *
 * Every client message is a POST of a single JSON-RPC message to one MCP
 * endpoint. The server answers a request with either `application/json` (one
 * object) or `text/event-stream` (SSE frames, the response arriving as one of
 * them); the spec says the client MUST support both, so both are implemented
 * here. A notification is answered with 202 Accepted and no body.
 *
 * mcplock only needs initialize + tools/list, so the standalone GET stream,
 * `Last-Event-ID` resumability, and server-initiated requests are out of
 * scope: unrecognised inbound messages are ignored rather than dispatched.
 */

/** POST must advertise both response shapes. */
const ACCEPT = 'application/json, text/event-stream';

/** Guard rail on the best-effort session teardown, which must not stall a CI run. */
const CLOSE_TIMEOUT_MS = 2_000;

/** Raised on 404 for a request that carried a session id: the session is gone. */
class SessionExpiredError extends Error {}

interface JsonRpcMessage {
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Validate a server URL. Credentials in the URL are rejected outright: the URL
 * is recorded in a lockfile that gets committed, and a token does not belong
 * in version control. Use `headers` instead.
 */
export function normalizeUrl(url: string, serverName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpLockError(`server "${serverName}" has an invalid url: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpLockError(
      `server "${serverName}" has an unsupported url scheme "${parsed.protocol}" (expected http: or https:)`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new McpLockError(
      `server "${serverName}" has credentials embedded in its url; the url is recorded in the lockfile, so pass secrets via "headers" instead`,
    );
  }
  return url;
}

function mediaType(res: Response): string {
  return (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
}

export class StreamableHttpMcpClient implements McpTransport {
  readonly name: string;
  private readonly url: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly inFlight = new Set<AbortController>();
  private sessionId: string | undefined;
  private negotiatedVersion: string | undefined;
  private nextId = 1;
  private closed = false;

  constructor(
    spec: HttpServerSpec,
    private readonly timeoutMs: number,
  ) {
    this.name = spec.name;
    this.url = normalizeUrl(spec.url, spec.name);
    this.extraHeaders = { ...(spec.headers ?? {}) };
    if (typeof globalThis.fetch !== 'function') {
      throw new McpLockError('the http transport needs a global fetch (Node 18 or newer)');
    }
  }

  /**
   * Session and protocol headers. Per the spec the session id goes on every
   * request once the server has issued one, and `MCP-Protocol-Version` goes on
   * every request *after* initialization, carrying the negotiated version (so
   * it is deliberately absent from the initialize POST itself).
   */
  private protocolHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.sessionId !== undefined) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.negotiatedVersion !== undefined) headers['MCP-Protocol-Version'] = this.negotiatedVersion;
    return headers;
  }

  private captureSession(res: Response): void {
    const id = res.headers.get('mcp-session-id');
    if (id !== null && id !== '' && this.sessionId === undefined) this.sessionId = id;
  }

  private async send(body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(this.url, {
      method: 'POST',
      headers: {
        ...this.extraHeaders,
        'content-type': 'application/json',
        accept: ACCEPT,
        ...this.protocolHeaders(),
      },
      body: JSON.stringify(body),
      // A redirect would mean the definitions came from somewhere other than
      // the URL that was pinned, which is exactly what this tool exists to
      // catch. Refuse rather than follow silently.
      redirect: 'manual',
      signal,
    });
  }

  /** Turn a non-2xx response into the most specific error we can justify. */
  private async statusError(res: Response, method: string, sentSession: boolean): Promise<Error> {
    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      return new McpLockError(
        `server "${this.name}" redirected ${method} away from ${this.url}${location ? ` to ${location}` : ''}; point the config at the final url so that what is pinned is what is contacted`,
      );
    }
    if (res.status === 404 && sentSession) {
      await res.body?.cancel();
      return new SessionExpiredError();
    }
    const snippet = await this.bodySnippet(res);
    if (res.status === 405) {
      return new McpLockError(
        `server "${this.name}" rejected POST ${this.url} with 405; mcplock speaks Streamable HTTP, not the deprecated HTTP+SSE transport`,
      );
    }
    if (res.status === 406) {
      return new McpLockError(
        `server "${this.name}" rejected the Accept header on ${method} with 406 (mcplock sends "${ACCEPT}")`,
      );
    }
    if (res.status === 400 && this.sessionId === undefined && this.negotiatedVersion !== undefined) {
      return new McpLockError(
        `server "${this.name}" returned 400 on ${method}; it may require a session id that it never issued${snippet}`,
      );
    }
    return new McpLockError(`server "${this.name}" returned HTTP ${res.status} ${res.statusText} on ${method}${snippet}`);
  }

  private async bodySnippet(res: Response): Promise<string> {
    try {
      const text = (await res.text()).trim();
      if (!text) return '';
      return `: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`;
    } catch {
      return '';
    }
  }

  /** POST one JSON-RPC request and read its response, whichever framing arrives. */
  private async roundTrip(
    message: { jsonrpc: string; id: number; method: string; params?: unknown },
    method: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    this.inFlight.add(controller);
    const sentSession = this.sessionId !== undefined;
    try {
      const res = await this.send(message, controller.signal);
      this.captureSession(res);
      if (!res.ok) throw await this.statusError(res, method, sentSession);
      if (res.status === 202) {
        await res.body?.cancel();
        throw new McpLockError(
          `server "${this.name}" answered the ${method} request with 202 Accepted and no body; a JSON-RPC request must get a response`,
        );
      }
      const type = mediaType(res);
      if (type === 'application/json') {
        let payload: unknown;
        try {
          payload = await res.json();
        } catch (err) {
          throw new McpLockError(
            `server "${this.name}" answered ${method} with an unparseable JSON body: ${(err as Error).message}`,
            err,
          );
        }
        return this.extract(payload, message.id, method);
      }
      if (type === 'text/event-stream') {
        return await this.readSse(res, message.id, method);
      }
      await res.body?.cancel();
      throw new McpLockError(
        `server "${this.name}" answered ${method} with unexpected content-type "${type || '(none)'}"; expected application/json or text/event-stream`,
      );
    } catch (err) {
      throw this.translate(err, method, timedOut);
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }

  private translate(err: unknown, method: string, timedOut: boolean): Error {
    if (timedOut) {
      return new McpLockError(`server "${this.name}" timed out after ${this.timeoutMs}ms waiting for ${method}`);
    }
    if (err instanceof McpLockError || err instanceof SessionExpiredError) return err;
    if (this.closed) return new McpLockError(`server "${this.name}" request for ${method} was cancelled by close()`);
    const cause = (err as { cause?: { message?: string; code?: string } }).cause;
    const detail = cause?.message ?? (err as Error).message;
    return new McpLockError(`server "${this.name}" could not be reached at ${this.url}: ${detail}`, err);
  }

  /** Pull the JSON-RPC message with our id out of a JSON body. */
  private extract(payload: unknown, id: number, method: string): unknown {
    // Batching was removed in 2025-06-18 but older servers may still answer
    // with an array, so accept either shape.
    const candidates = Array.isArray(payload) ? payload : [payload];
    for (const candidate of candidates) {
      const msg = candidate as JsonRpcMessage | null;
      if (msg === null || typeof msg !== 'object' || msg.id !== id) continue;
      if (msg.error) {
        throw new McpLockError(
          `server "${this.name}" returned JSON-RPC error ${msg.error.code}: ${msg.error.message}`,
          { jsonRpcCode: msg.error.code },
        );
      }
      return msg.result;
    }
    throw new McpLockError(`server "${this.name}" answered ${method} without a JSON-RPC message for id ${id}`);
  }

  /**
   * Read SSE frames until the response for `id` arrives. Anything else on the
   * stream (keep-alive comments, priming events with empty data, server
   * notifications) is skipped.
   */
  private async readSse(res: Response, id: number, method: string): Promise<unknown> {
    const body = res.body;
    if (!body) {
      throw new McpLockError(`server "${this.name}" opened an SSE response for ${method} with no body`);
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    const scan = (events: SseEvent[]): { found: true; value: unknown } | null => {
      for (const event of events) {
        if (event.data === '') continue; // priming / keep-alive event
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          continue; // not a JSON-RPC frame, not ours to interpret
        }
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const candidate of candidates) {
          const msg = candidate as JsonRpcMessage | null;
          if (msg === null || typeof msg !== 'object' || msg.id !== id) continue;
          if (msg.error) {
            throw new McpLockError(
              `server "${this.name}" returned JSON-RPC error ${msg.error.code}: ${msg.error.message}`,
              { jsonRpcCode: msg.error.code },
            );
          }
          return { found: true, value: msg.result };
        }
      }
      return null;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush: a server that omits the final blank line still gets its
          // last frame read, rather than silently losing the response.
          const hit = scan(sse.push(`${decoder.decode()}\n\n`));
          if (hit) return hit.value;
          throw new McpLockError(
            `server "${this.name}" closed the SSE stream for ${method} without sending a response for id ${id}`,
          );
        }
        const hit = scan(sse.push(decoder.decode(value, { stream: true })));
        if (hit) return hit.value;
      }
    } finally {
      // The spec has the server close the stream after the response, but do
      // not depend on it: hang up so the socket is not held open.
      await reader.cancel().catch(() => {});
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new McpLockError(`server "${this.name}" client is closed`);
    const message = { jsonrpc: '2.0', id: this.nextId++, method, params };
    try {
      return await this.roundTrip(message, method);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      // Spec: a 404 for a request carrying a session id means the session was
      // terminated, and the client MUST start a new one. Replay once.
      if (method === 'initialize') {
        throw new McpLockError(`server "${this.name}" returned 404 for initialize at ${this.url}`);
      }
      await this.reinitialize();
      return await this.roundTrip({ jsonrpc: '2.0', id: this.nextId++, method, params }, method);
    }
  }

  private async reinitialize(): Promise<void> {
    this.sessionId = undefined;
    this.negotiatedVersion = undefined;
    const result = await this.roundTrip(
      {
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      },
      'initialize',
    );
    this.onInitialized(result);
    await this.notify('notifications/initialized');
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new McpLockError(`server "${this.name}" client is closed`);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    this.inFlight.add(controller);
    const sentSession = this.sessionId !== undefined;
    try {
      const res = await this.send(
        { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) },
        controller.signal,
      );
      this.captureSession(res);
      if (!res.ok) throw await this.statusError(res, method, sentSession);
      // Spec: 202 Accepted with no body. Drain whatever arrived so the socket
      // is released either way.
      await res.body?.cancel();
    } catch (err) {
      const translated = this.translate(err, method, timedOut);
      throw translated instanceof SessionExpiredError
        ? new McpLockError(`server "${this.name}" returned 404 for ${method}: the session expired mid-handshake`)
        : translated;
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }

  /** Latch the negotiated protocol version, which every later request echoes. */
  onInitialized(result: unknown): void {
    const version = (result as { protocolVersion?: unknown } | null)?.protocolVersion;
    this.negotiatedVersion = typeof version === 'string' && version !== '' ? version : PROTOCOL_VERSION;
  }

  /**
   * Abort anything in flight, then best-effort DELETE the session. The spec
   * lets a server refuse with 405, and a teardown failure must never turn a
   * clean verify into a red build, so every outcome here is ignored.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    if (this.sessionId === undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, CLOSE_TIMEOUT_MS));
    try {
      const res = await fetch(this.url, {
        method: 'DELETE',
        headers: { ...this.extraHeaders, ...this.protocolHeaders() },
        redirect: 'manual',
        signal: controller.signal,
      });
      await res.body?.cancel();
    } catch {
      // Nothing actionable: the session either expired already or the server
      // does not implement DELETE.
    } finally {
      clearTimeout(timer);
      this.sessionId = undefined;
    }
  }
}

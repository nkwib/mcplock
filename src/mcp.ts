import { McpLockError, type ToolDefinition } from './types';

/**
 * Protocol revision mcplock asks for in `initialize` and echoes in the
 * `MCP-Protocol-Version` header on Streamable HTTP.
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
 */
export const PROTOCOL_VERSION = '2025-06-18';
export const CLIENT_INFO = { name: 'mcplock', version: '0.2.0' };

/**
 * The slice of MCP that a transport has to provide for pinning: send a
 * request, send a notification, hang up. Everything above this line
 * (initialize, tools/list, pagination) is transport independent and lives in
 * `collectTools`.
 */
export interface McpTransport {
  readonly name: string;
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  /** Called once the initialize result is in, so a transport can latch the negotiated version. */
  onInitialized(result: unknown): void;
  close(): void | Promise<void>;
}

const METHOD_NOT_FOUND = -32601;

/** Initialize, then walk `tools/list` to the end of its cursor chain. */
export async function collectTools(client: McpTransport): Promise<ToolDefinition[]> {
  let initResult: unknown;
  try {
    initResult = await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
  } catch (err) {
    const code = (err as McpLockError).cause as { jsonRpcCode?: number } | undefined;
    if (code?.jsonRpcCode === METHOD_NOT_FOUND) {
      throw new McpLockError(
        `${(err as Error).message}\nmcplock speaks the handshake-based MCP revision ${PROTOCOL_VERSION}; a server on revision 2026-07-28 or later has no initialize method and is not supported yet`,
        err,
      );
    }
    throw err;
  }
  client.onInitialized(initResult);
  await client.notify('notifications/initialized');

  const tools: ToolDefinition[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = (await client.request('tools/list', cursor === undefined ? {} : { cursor })) as {
      tools?: unknown[];
      nextCursor?: string;
    };
    if (!Array.isArray(result?.tools)) {
      throw new McpLockError(`server "${client.name}" returned no tools array from tools/list`);
    }
    for (const raw of result.tools) {
      const t = raw as Record<string, unknown>;
      if (typeof t.name !== 'string') {
        throw new McpLockError(`server "${client.name}" returned a tool without a string name`);
      }
      tools.push({
        name: t.name,
        title: t.title as string | undefined,
        description: t.description as string | undefined,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
        annotations: t.annotations,
      });
    }
    cursor = result.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new McpLockError(`server "${client.name}" repeated tools/list cursor "${cursor}": refusing to page forever`);
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

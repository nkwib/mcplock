import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpLockError, type ServerSpec, type ToolDefinition } from './types';

const PROTOCOL_VERSION = '2025-06-18';
export const CLIENT_INFO = { name: 'mcplock', version: '0.1.0' };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal JSON-RPC 2.0 client over MCP stdio framing (one JSON message per
 * line on stdout/stdin). Enough protocol to initialize and list tools,
 * nothing more.
 */
export class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderrTail = '';
  private closed = false;

  constructor(
    private readonly spec: ServerSpec,
    private readonly timeoutMs: number,
  ) {
    this.child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...spec.env },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    this.child.on('error', (err) => this.failAll(new McpLockError(`failed to spawn "${spec.command}": ${err.message}`, err)));
    this.child.on('exit', (code) => {
      if (this.pending.size > 0) {
        this.failAll(
          new McpLockError(
            `server "${spec.name}" exited (code ${code}) before responding${this.stderrTail ? `; stderr: ${this.stderrTail.trim()}` : ''}`,
          ),
        );
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not JSON, likely stray server logging on stdout
      }
      if (typeof msg.id !== 'number') continue; // notification or request from server, out of scope
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new McpLockError(`server "${this.spec.name}" returned JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpLockError(`server "${this.spec.name}" timed out after ${this.timeoutMs}ms waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  }

  private notify(method: string, params?: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  }

  async listAllTools(): Promise<ToolDefinition[]> {
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this.notify('notifications/initialized');
    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.request('tools/list', cursor === undefined ? {} : { cursor })) as {
        tools?: unknown[];
        nextCursor?: string;
      };
      if (!Array.isArray(result?.tools)) {
        throw new McpLockError(`server "${this.spec.name}" returned no tools array from tools/list`);
      }
      for (const raw of result.tools) {
        const t = raw as Record<string, unknown>;
        if (typeof t.name !== 'string') {
          throw new McpLockError(`server "${this.spec.name}" returned a tool without a string name`);
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
    } while (cursor !== undefined);
    return tools;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

export async function fetchTools(spec: ServerSpec, timeoutMs: number): Promise<ToolDefinition[]> {
  const client = new StdioMcpClient(spec, timeoutMs);
  try {
    return await client.listAllTools();
  } finally {
    client.close();
  }
}

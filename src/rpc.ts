import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StreamableHttpMcpClient } from './http';
import { collectTools, PROTOCOL_VERSION, type McpTransport } from './mcp';
import { isHttpSpec, McpLockError, type ServerSpec, type StdioServerSpec, type ToolDefinition } from './types';

export { CLIENT_INFO, PROTOCOL_VERSION } from './mcp';

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
export class StdioMcpClient implements McpTransport {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private stderrTail = '';
  private closed = false;
  readonly name: string;

  constructor(
    private readonly spec: StdioServerSpec,
    private readonly timeoutMs: number,
  ) {
    this.name = spec.name;
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
        pending.reject(
          new McpLockError(`server "${this.spec.name}" returned JSON-RPC error ${msg.error.code}: ${msg.error.message}`, {
            jsonRpcCode: msg.error.code,
          }),
        );
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

  request(method: string, params: unknown): Promise<unknown> {
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

  async notify(method: string, params?: unknown): Promise<void> {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  }

  /** No-op for stdio: the protocol version is negotiated in-band by initialize. */
  onInitialized(): void {}

  async listAllTools(): Promise<ToolDefinition[]> {
    return collectTools(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Connect to a server over whichever transport its spec describes, list every tool, disconnect. */
export async function fetchTools(spec: ServerSpec, timeoutMs: number): Promise<ToolDefinition[]> {
  const client: McpTransport = isHttpSpec(spec)
    ? new StreamableHttpMcpClient(spec, timeoutMs)
    : new StdioMcpClient(spec, timeoutMs);
  try {
    return await collectTools(client);
  } finally {
    await client.close();
  }
}

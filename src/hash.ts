import { canonicalJson } from './canonicalize';
import type { ToolDefinition } from './types';

type Subtle = { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };

async function getSubtle(): Promise<Subtle> {
  const g = globalThis as { crypto?: { subtle?: Subtle } };
  if (g.crypto?.subtle) return g.crypto.subtle;
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle as unknown as Subtle;
}

export async function sha256Hex(input: string): Promise<string> {
  const subtle = await getSubtle();
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Hash of the full canonicalized tool definition (descriptions included). */
export async function hashToolDefinition(definition: ToolDefinition): Promise<string> {
  return sha256Hex(canonicalJson(definition));
}

/** Aggregate hash for a server: sha-256 over the sorted per-tool hashes. */
export async function rootHash(toolHashes: string[]): Promise<string> {
  return sha256Hex([...toolHashes].sort().join('\n'));
}

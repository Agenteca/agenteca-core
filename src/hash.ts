import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `<algo>:<hex>` envelope required by req-lk-016. */
export function envelope(hex: string): string {
  return `sha256:${hex}`;
}

/** Accepts the envelope or bare hexadecimal (reading tolerance of v0.1). */
export function normalizeEnvelope(value: string): string {
  return /^[0-9a-f]{64}$/.test(value) ? `sha256:${value}` : value;
}

/**
 * Canonical content of a deployed file (req-lk-012): for a text file
 * (valid UTF-8, no NUL byte) each `\r\n` becomes `\n`; a binary
 * file is hashed as is.
 */
export function canonicalContent(bytes: Buffer): Buffer {
  if (bytes.includes(0) || !isUtf8(bytes)) return bytes;
  if (!bytes.includes(13)) return bytes;
  const out = Buffer.allocUnsafe(bytes.length);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    out[j++] = bytes[i]!;
  }
  return out.subarray(0, j);
}

export function fileHash(bytes: Buffer): string {
  return envelope(sha256Hex(canonicalContent(bytes)));
}

export interface TreeEntry {
  mode: string;
  name: string;
  /** Hexadecimal SHA-256 of the blob, or of the canonical representation of the subtree. */
  sha256: string;
}

/**
 * Canonical representation of a git tree (spec §5.6.4):
 * `<mode> SP <name> SP <sha256> LF`, entries sorted byte by byte on the name.
 */
export function canonicalTreeHash(entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const h = createHash('sha256');
  for (const e of sorted) h.update(`${e.mode} ${e.name} ${e.sha256}\n`, 'utf8');
  return h.digest('hex');
}

/** Canonical JSON (sorted keys) to produce stable hashes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

import path from 'node:path';
import fs from 'node:fs/promises';

export const blocked = /^(\.env($|\.)|id_(rsa|ed25519|ecdsa|dsa)$|credentials\.json$|.*\.(pem|key|p12|pfx)$)/i;
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/(authToken|access_token|authorization|cookie|fingerprintHash)(["']?\s*[:=]\s*["']?)[^,"'\s}]+/gi, '$1$2[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [/token|secret|password|cookie|fingerprinthash|authorization/i.test(k) ? k : k, /token|secret|password|cookie|fingerprinthash|authorization/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}
export function assertSafeId(id: string): string { if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw new Error('Invalid identifier'); return id; }
export async function safeProjectPath(root: string, requested: string): Promise<string> {
  const base = await fs.realpath(root);
  const candidate = await fs.realpath(path.resolve(base, requested));
  const rel = path.relative(base, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes the Freebuff project');
  const parts = rel.split(path.sep);
  if (parts.some((part) => blocked.test(part))) throw new Error('Protected file access denied');
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) throw new Error('Only regular files may be read');
  return candidate;
}


import path from 'node:path';
import fs from 'node:fs/promises';

export const blocked = /^(\.env($|\.)|\.npmrc$|\.pypirc$|\.netrc$|credentials?\.json$|secrets?\.(ya?ml|json|toml)$|.*\.(pem|key|p12|pfx|jks|kdbx)$|id_(rsa|ed25519|ecdsa|dsa)$)/i;
export const MAX_READ_BYTES = 1_000_000;
const secretText = /(authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi;
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/(authToken|access_token|authorization|cookie|fingerprintHash|api[_-]?key|client[_-]?secret|private[_-]?key)(["']?\s*[:=]\s*["']?)[^,"'\s}]+/gi, '$1$2[REDACTED]').replace(secretText, '$1=[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [/token|secret|password|cookie|fingerprinthash|authorization/i.test(k) ? k : k, /token|secret|password|cookie|fingerprinthash|authorization/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}
export function safeTextContent(data: Buffer, file: string): string {
  if (data.length > MAX_READ_BYTES) throw new Error('File exceeds the 1 MB read limit');
  if (data.includes(0)) throw new Error('Binary file access denied');
  return String(redact(data.toString('utf8')));
}
export function sanitizeFreebuff(value: unknown): unknown {
  if (Array.isArray(value)) return value.flatMap((item) => { const clean = sanitizeFreebuff(item); return clean === undefined ? [] : [clean]; });
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'reasoning' || key === 'chainOfThought' || key === 'chain_of_thought' || key === 'metrics') continue;
      if (key === 'kind' && (item === 'reasoning' || item === 'tool' || item === 'ad')) return undefined;
      out[key] = sanitizeFreebuff(item);
    }
    return redact(out);
  }
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
  if (stat.size > MAX_READ_BYTES) throw new Error('File exceeds the 1 MB read limit');
  return candidate;
}

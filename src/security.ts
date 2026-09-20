import path from 'node:path';
import fs from 'node:fs/promises';

export const blocked = /^(\.env($|\.)|\.npmrc$|\.pypirc$|\.netrc$|credentials?\.json$|secrets?\.(ya?ml|json|toml)$|.*\.(pem|key|p12|pfx|jks|kdbx)$|id_(rsa|ed25519|ecdsa|dsa)$)/i;
export const MAX_READ_BYTES = 1_000_000;

// Key-name based redaction: any key that looks credential-like.
const SENSITIVE_KEY = /^(authorization|proxy-authorization|www-authenticate|bearer|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|api-key|client[_-]?secret|private[_-]?key|secret|secret[_-]?key|password|passwd|pwd|cookie|set-cookie|session[_-]?token|auth[_-]?token|fingerprinthash|x-api-key|x-auth-token|x-csrf-token|csrf)$/i;
const SENSITIVE_KEY_SUBSTRING = /token|secret|password|cookie|credential|authkey|privatekey|fingerprint/i;

// Value-pattern based redaction for strings.
const secretText = /(authorization\s*[:=]\s*|bearer\s+|access[_-]?token\s*["']?\s*[:=]\s*["']?|refresh[_-]?token\s*["']?\s*[:=]\s*["']?|api[_-]?key\s*["']?\s*[:=]\s*["']?|api-key\s*[:=]\s*|client[_-]?secret\s*["']?\s*[:=]\s*["']?|private[_-]?key\s*[:=]\s*|cookie\s*[:=]\s*|session[_-]?token\s*[:=]\s*)[^\s,;'"}]+/gi;
// Query-string tokens (e.g. ?token=..., &api_key=...) when recognizable.
const queryStringToken = /([?&](?:token|access_token|refresh_token|api_key|apikey|api-key|key|secret|password|sig|signature|session)")[^&\s"']*/gi;
const queryStringToken2 = /([?&](?:token|access_token|refresh_token|api_key|apikey|api-key|key|secret|password|sig|signature|session)=)[^&\s"']+/gi;
const bearerHeader = /bearer\s+[\w.\-~+/=]{8,}/gi;

export function redactString(value: string): string {
  let out = value.replace(bearerHeader, 'Bearer [REDACTED]');
  out = out.replace(secretText, (match) => `${match.split(/[:=]/)[0]?.trim() ?? match}=[REDACTED]`);
  out = out.replace(queryStringToken, '$1[REDACTED]');
  out = out.replace(queryStringToken2, '$1[REDACTED]');
  return out;
}

export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value.replace(/(authToken|access_token|authorization|cookie|fingerprintHash|api[_-]?key|client[_-]?secret|private[_-]?key)(["']?\s*[:=]\s*["']?)[^,"'\s}]+/gi, '$1$2[REDACTED]'));
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) || (SENSITIVE_KEY_SUBSTRING.test(key) && typeof item === 'string' && item.length > 0) ? '[REDACTED]' : redact(item),
    ]));
  }
  return value;
}

export function safeTextContent(data: Buffer, file: string): string {
  if (data.length > MAX_READ_BYTES) throw new Error('File exceeds the 1 MB read limit');
  if (data.includes(0)) throw new Error('Binary file access denied');
  return String(redact(data.toString('utf8')));
}

/**
 * Remove hidden reasoning/ad content but PRESERVE visible tool activity so
 * progress can be surfaced without exposing hidden reasoning or credentials.
 * Previously this stripped every tool object wholesale; now tool entries keep
 * their tool name, command, and file lists (redacted) while any reasoning-ish
 * fields inside them are dropped.
 */
export function sanitizeFreebuff(value: unknown): unknown {
  if (Array.isArray(value)) return value.flatMap((item) => { const clean = sanitizeFreebuff(item); return clean === undefined ? [] : [clean]; });
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Drop message kinds that carry hidden reasoning or ads entirely.
    if (record.kind === 'reasoning' || record.kind === 'ad') return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (key === 'reasoning' || key === 'chainOfThought' || key === 'chain_of_thought' || key === 'metrics') continue;
      out[key] = sanitizeFreebuff(item);
    }
    // For tool entries, drop hidden fields but keep name/command/files.
    if (typeof record.kind === 'string' && record.kind.toLowerCase().includes('tool')) {
      const keep: Record<string, unknown> = {};
      for (const field of ['kind', 'tool', 'toolName', 'command', 'files', 'status', 'state', 'label', 'title', 'output']) {
        if (out[field] !== undefined) keep[field] = out[field];
      }
      return redact(keep);
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

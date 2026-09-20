import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const HANDOFF_VERSION = 1;
export const HANDOFF_ENV = 'FREEBUFF_MCP_HANDOFF_FILE';

export interface DesktopHandoff {
  version: number;
  url: string;
  launchId: string;
  pid: number;
  expiresAt: string;
}

export interface HandoffValidation {
  valid: boolean;
  reason?: string;
  handoff?: DesktopHandoff;
  path?: string;
}

function isLoopbackUrl(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]');
}

export function processIsAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return true; // unknown pids are not treated as dead
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Read and validate a Desktop handoff file. Validation covers: file presence,
 * JSON shape, format version, loopback URL, live PID, and freshness. The file
 * itself is written by the Desktop (or a test fixture) into the current user's
 * own config directory; it never contains credentials, only a loopback URL and
 * a short-lived launch id that the Desktop will challenge over HTTP.
 */
export async function readHandoff(explicitPath?: string): Promise<HandoffValidation> {
  const handoffPath = explicitPath ?? process.env[HANDOFF_ENV];
  if (!handoffPath) return { valid: false, reason: 'no_handoff_configured' };
  let raw: string;
  try { raw = await fs.readFile(handoffPath, 'utf8'); } catch { return { valid: false, reason: 'handoff_missing', path: handoffPath }; }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { valid: false, reason: 'handoff_malformed_json', path: handoffPath }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, reason: 'handoff_malformed_json', path: handoffPath };
  const record = value as Record<string, unknown>;
  if (record.version !== HANDOFF_VERSION) return { valid: false, reason: 'handoff_unsupported_version', path: handoffPath };
  const url = typeof record.url === 'string' ? record.url : undefined;
  const launchId = typeof record.launchId === 'string' ? record.launchId : undefined;
  const pid = Number(record.pid);
  const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : undefined;
  if (!url) return { valid: false, reason: 'handoff_missing_url', path: handoffPath };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { valid: false, reason: 'handoff_invalid_url', path: handoffPath }; }
  if (!isLoopbackUrl(parsed)) return { valid: false, reason: 'handoff_non_loopback_url', path: handoffPath };
  if (!launchId) return { valid: false, reason: 'handoff_missing_launch_id', path: handoffPath };
  if (!Number.isInteger(pid) || pid <= 0) return { valid: false, reason: 'handoff_invalid_pid', path: handoffPath };
  if (!processIsAlive(pid)) return { valid: false, reason: 'handoff_dead_pid', path: handoffPath };
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) return { valid: false, reason: 'handoff_missing_expiry', path: handoffPath };
  if (Date.parse(expiresAt) <= Date.now()) return { valid: false, reason: 'handoff_expired', path: handoffPath };
  return { valid: true, handoff: { version: HANDOFF_VERSION, url, launchId, pid, expiresAt }, path: handoffPath };
}

/**
 * Write a handoff file (used by tests and available to the Desktop). The file
 * lives under the current user's config directory so it is never shared across
 * user boundaries.
 */
export async function writeHandoff(handoff: Omit<DesktopHandoff, 'version'> & { version?: number }, explicitPath?: string): Promise<string> {
  const target = explicitPath ?? process.env[HANDOFF_ENV] ?? path.join(os.homedir(), '.config', 'freebuff-desktop', 'mcp-handoff.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ version: HANDOFF_VERSION, ...handoff }, null, 2), 'utf8');
  return target;
}

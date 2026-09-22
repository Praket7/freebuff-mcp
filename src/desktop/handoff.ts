import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const HANDOFF_VERSION = 1;
export const HANDOFF_ENV = 'FREEBUFF_MCP_HANDOFF_FILE';
const HANDOFF_MAX_BYTES = 64 * 1024;

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
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Platform-default handoff locations the stock Desktop writes. `readHandoff`
 * consults these when no explicit path (or env var) is configured, so handoff
 * discovery is automatic; `writeHandoff` defaults to the current platform's
 * entry. The file carries only a loopback URL plus a short-lived launch id
 * that the Desktop challenges over HTTP — never credentials.
 */
export function defaultHandoffPaths(): string[] {
  const home = os.homedir();
  const defaults: string[] = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) defaults.push(path.join(process.env.APPDATA, 'Freebuff', 'mcp-handoff.json'));
  } else if (process.platform === 'darwin') {
    defaults.push(path.join(home, 'Library', 'Application Support', 'Freebuff', 'mcp-handoff.json'));
    defaults.push(path.join(home, '.config', 'freebuff-desktop', 'mcp-handoff.json'));
  } else {
    defaults.push(path.join(home, '.config', 'freebuff-desktop', 'mcp-handoff.json'));
  }
  return defaults;
}

/**
 * Read and validate a Desktop handoff file. An explicit path (or the env var)
 * wins; otherwise every platform-default location is tried in order. An
 * invalid stale first default must not mask a later valid default.
 */
export async function readHandoff(explicitPath?: string): Promise<HandoffValidation> {
  const configured = explicitPath ?? process.env[HANDOFF_ENV];
  if (configured) return validateHandoffFile(configured);

  let firstInvalid: HandoffValidation | undefined;
  for (const fallback of defaultHandoffPaths()) {
    const result = await validateHandoffFile(fallback);
    if (result.valid) return result;
    if (result.reason !== 'handoff_missing' && !firstInvalid) firstInvalid = result;
  }
  return firstInvalid ?? { valid: false, reason: 'no_handoff_configured' };
}

async function validateHandoffFile(handoffPath: string): Promise<HandoffValidation> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(handoffPath);
  } catch {
    return { valid: false, reason: 'handoff_missing', path: handoffPath };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { valid: false, reason: 'handoff_invalid_file_type', path: handoffPath };
  if (stat.size > HANDOFF_MAX_BYTES) return { valid: false, reason: 'handoff_too_large', path: handoffPath };

  try {
    await verifyHandoffOwnership(handoffPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = /permissions/i.test(message)
      ? 'handoff_insecure_permissions'
      : /symbolic|regular file/i.test(message)
        ? 'handoff_invalid_file_type'
        : /large|size/i.test(message)
          ? 'handoff_too_large'
          : 'handoff_untrusted_owner';
    return { valid: false, reason, path: handoffPath };
  }

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
 * Write a handoff file atomically in the current user's config directory.
 * A same-directory owner-only temporary file prevents partial JSON from being
 * observed and avoids following a pre-existing symlink at the destination.
 */
export async function writeHandoff(handoff: Omit<DesktopHandoff, 'version'> & { version?: number }, explicitPath?: string): Promise<string> {
  const target = explicitPath ?? process.env[HANDOFF_ENV] ?? defaultHandoffPaths()[0] ?? path.join(os.homedir(), '.config', 'freebuff-desktop', 'mcp-handoff.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ version: HANDOFF_VERSION, ...handoff }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  await verifyHandoffOwnership(target);
  return target;
}

/**
 * Confirm a handoff is a small regular file owned by the current user. On
 * POSIX, group/other access is forbidden because the file carries a live
 * launch id. Windows relies on the current-user profile ACL contract.
 */
export async function verifyHandoffOwnership(handoffPath: string): Promise<void> {
  const stat = await fs.lstat(handoffPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Refusing handoff path that is not a regular file (${handoffPath}).`);
  if (stat.size > HANDOFF_MAX_BYTES) throw new Error(`Refusing handoff file larger than ${HANDOFF_MAX_BYTES} bytes (${handoffPath}).`);
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  if (stat.uid !== process.getuid?.()) {
    throw new Error(`Refusing handoff file owned by uid ${stat.uid}, expected ${process.getuid?.()} (${handoffPath}).`);
  }
  const permissions = stat.mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    throw new Error(`Refusing handoff file with permissions ${permissions.toString(8)}; group/other access is not allowed (${handoffPath}).`);
  }
}

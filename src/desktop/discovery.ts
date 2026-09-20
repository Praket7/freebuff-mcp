import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readHandoff, processIsAlive } from './handoff.js';

const execFileAsync = promisify(execFile);

export interface DesktopCandidate {
  url: string;
  launchId?: string;
  pid?: number;
  /** Where this candidate came from (used for diagnostics and ordering). */
  source: 'handoff' | 'explicit' | 'readiness' | 'process' | 'log' | 'listener';
}

export interface DiscoveryResult {
  candidate: DesktopCandidate | null;
  /** All candidates considered, in priority order (for diagnostics). */
  considered: DesktopCandidate[];
  /** Why discovery failed, when it failed. */
  reason?: string;
}

const DISCOVERY_TTL_MS = 10_000;
const FRESHNESS_MS = 10 * 60_000;

function asString(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }

function readinessFiles(): string[] {
  const home = os.homedir();
  return [
    ...(process.env.FREEBUFF_READINESS_FILE ? [process.env.FREEBUFF_READINESS_FILE] : []),
    path.join(home, '.config', 'freebuff-desktop', 'orchestrator.json'),
    path.join(home, '.config', 'freebuff-desktop', 'readiness.json'),
    path.join(process.env.APPDATA ?? '', 'Freebuff', 'orchestrator.json'),
    path.join(process.env.APPDATA ?? '', 'Freebuff', 'readiness.json'),
    path.join(home, 'Library', 'Application Support', 'Freebuff', 'orchestrator.json'),
    path.join(home, 'Library', 'Application Support', 'Freebuff', 'readiness.json'),
    path.join(home, '.config', 'Freebuff', 'orchestrator.json'),
    path.join(home, '.config', 'Freebuff', 'readiness.json'),
  ].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
}

function logFiles(): string[] {
  const home = os.homedir();
  return [
    path.join(process.env.APPDATA ?? '', 'Freebuff', 'logs', 'orchestrator-stderr.log'),
    path.join(home, 'Library', 'Application Support', 'Freebuff', 'logs', 'orchestrator-stderr.log'),
    path.join(home, 'Library', 'Logs', 'Freebuff', 'orchestrator-stderr.log'),
    path.join(home, '.config', 'Freebuff', 'logs', 'orchestrator-stderr.log'),
    path.join(home, '.local', 'share', 'Freebuff', 'logs', 'orchestrator-stderr.log'),
  ].filter(Boolean);
}

/**
 * Ordered, minimized Desktop discovery:
 * 1. explicit handoff file (FREEBUFF_MCP_HANDOFF_FILE)
 * 2. explicit configured URL (FREEBUFF_ORCHESTRATOR_URL)
 * 3. readiness metadata files
 * 4. running orchestrator process environment (macOS/Linux only, current user)
 * 5. log-file port hints
 * 6. narrow listener fallback ONLY when nothing else matched
 *
 * Results are cached briefly so normal tool calls never re-scan.
 */
export async function discoverDesktopCandidates(): Promise<{ candidates: DesktopCandidate[]; reason?: string }> {
  const candidates: DesktopCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: DesktopCandidate): void => {
    if (seen.has(candidate.url)) return;
    seen.add(candidate.url);
    candidates.push(candidate);
  };

  // 1. Handoff (validated: version, loopback, live pid, expiry).
  const handoff = await readHandoff();
  if (handoff.valid && handoff.handoff) {
    push({ url: handoff.handoff.url, launchId: handoff.handoff.launchId, pid: handoff.handoff.pid, source: 'handoff' });
  }

  // 2. Explicit configured URL.
  if (process.env.FREEBUFF_ORCHESTRATOR_URL) {
    push({ url: process.env.FREEBUFF_ORCHESTRATOR_URL, launchId: process.env.FREEBUFF_LAUNCH_ID, source: 'explicit' });
  }

  // 3. Readiness metadata (freshness + live pid required).
  for (const file of readinessFiles()) {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      const port = typeof value.port === 'number' || typeof value.port === 'string' ? Number(value.port) : undefined;
      const url = asString(value.url) ?? (port && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : undefined);
      if (!url) continue;
      const launchId = asString(value.launchId) ?? asString(value['launch-id']) ?? asString(value.launch_id);
      const pidValue = Number(value.pid ?? value.processId ?? value.process_id);
      const pid = Number.isInteger(pidValue) && pidValue > 0 ? pidValue : undefined;
      const freshnessValue = value.timestamp ?? value.updatedAt ?? value.updated_at;
      const freshness = typeof freshnessValue === 'number' ? freshnessValue : typeof freshnessValue === 'string' ? Date.parse(freshnessValue) : undefined;
      if (freshness && Date.now() - freshness > FRESHNESS_MS) continue;
      if (!processIsAlive(pid)) continue;
      push({ url, launchId, pid, source: 'readiness' });
    } catch { /* optional metadata */ }
  }

  // 4. Live orchestrator process (macOS/Linux, current user only).
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      const { stdout } = await execFileAsync('ps', ['eww', '-Ao', 'pid,command'], { timeout: 2000 });
      for (const line of stdout.split('\n')) {
        if (!line.includes('orchestrator.js')) continue;
        const pid = Number(line.match(/^\s*(\d+)/)?.[1]);
        const launchId = line.match(/FREEBUFF_LAUNCH_ID=([^\s]+)/)?.[1];
        let port = Number(line.match(/FREEBUFF_ORCHESTRATOR_PORT=(\d+)/)?.[1]);
        if (!port) {
          try {
            const { stdout: sockets } = await execFileAsync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { timeout: 2000 });
            port = Number(sockets.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\(LISTEN\)/)?.[1]);
          } catch { /* lsof unavailable */ }
        }
        if (Number.isInteger(pid) && pid > 0 && launchId && Number.isInteger(port) && port > 0 && port < 65536) {
          push({ url: `http://127.0.0.1:${port}`, launchId, pid, source: 'process' });
        }
      }
    } catch { /* best effort */ }
  }

  // 5. Log-file port hints.
  const logUrls: string[] = [];
  for (const log of logFiles()) {
    try {
      const text = await fs.readFile(log, 'utf8');
      for (const match of text.matchAll(/127\.0\.0\.1:(\d+)/g)) logUrls.push(`http://127.0.0.1:${match[1]}`);
    } catch { /* try next location */ }
  }
  // Newest last so they sort first in the reversed listener list below.
  for (const url of logUrls.reverse()) push({ url, source: 'log' });

  // 6. Narrow listener fallback — only when nothing above produced a candidate.
  if (candidates.length === 0 && logUrls.length === 0) {
    try {
      const ports = process.platform === 'win32'
        ? (await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 | Select-Object -ExpandProperty LocalPort'], { timeout: 2000 })).stdout
        : (await execFileAsync('sh', ['-c', "command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP -sTCP:LISTEN -a -4 -F n | sed -n 's/^n.*:\\([0-9][0-9]*\\)$/\\1/p'"], { timeout: 2000 })).stdout;
      for (const port of ports.match(/\b[0-9]{2,5}\b/g) ?? []) {
        const n = Number(port);
        if (n > 0 && n < 65536) push({ url: `http://127.0.0.1:${n}`, source: 'listener' });
      }
    } catch { /* no listener utility available */ }
  }

  return { candidates, reason: candidates.length ? undefined : 'no_candidates' };
}

async function probeCandidate(candidate: DesktopCandidate): Promise<DesktopCandidate | null> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (candidate.launchId) headers['x-freebuff-launch-id'] = candidate.launchId;
  try {
    const response = await fetch(new URL('/api/projects', candidate.url), { signal: AbortSignal.timeout(1500), headers });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== 'object' || !Array.isArray((body as Record<string, unknown>).projects)) return null;
    if (candidate.launchId) {
      const health = await fetch(new URL('/healthz', candidate.url), { signal: AbortSignal.timeout(1500), headers });
      if (!health.ok) return null;
    }
    return candidate;
  } catch { return null; }
}

export interface DiscoverLiveOptions { force?: boolean }

const cache = new Map<string, { at: number; candidates: DesktopCandidate[]; reason?: string }>();

/**
 * Probe candidates in priority order and return the first healthy one.
 * Cached for DISCOVERY_TTL_MS unless force-refreshed (e.g. after a connection
 * error triggers rediscovery).
 */
export async function discoverDesktopCandidate(options: DiscoverLiveOptions = {}): Promise<DesktopCandidate | null> {
  return (await discoverDesktop(options)).candidate;
}

export async function discoverDesktop(options: DiscoverLiveOptions = {}): Promise<DiscoveryResult> {
  const cacheKey = 'default';
  const cached = cache.get(cacheKey);
  if (!options.force && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
    return { candidate: cached.candidates[0] ?? null, considered: cached.candidates, reason: cached.candidates.length ? undefined : cached.reason };
  }
  const { candidates, reason } = await discoverDesktopCandidates();
  const verified: DesktopCandidate[] = [];
  for (const candidate of candidates) {
    const ok = await probeCandidate(candidate);
    if (ok) verified.push(ok);
    if (ok) break; // first healthy candidate wins; keep the rest listed for diagnostics
  }
  cache.set(cacheKey, { at: Date.now(), candidates: verified, reason });
  return { candidate: verified[0] ?? null, considered: verified.length ? verified : candidates, reason: verified.length ? undefined : (reason ?? 'no_healthy_candidate') };
}

/** Invalidate the discovery cache (used on reconnect). */
export function invalidateDiscoveryCache(): void { cache.clear(); }

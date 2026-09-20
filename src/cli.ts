#!/usr/bin/env node
import { runHttp, runStdio } from './mcp.js';
import { runStdioV2 } from './mcp-v2.js';
import { runAcp } from './acp.js';
import { installCodex } from './install/codex.js';
import { installClaude } from './install/claude.js';
import { findFreebuffCli } from './pty.js';
import { discoverDesktop } from './desktop/discovery.js';
import { DesktopBackend } from './backends/desktop-backend.js';
import { CliBackend } from './backends/cli-backend.js';
import { nodePtyVersion } from './diagnostics.js';import { VERSION } from './version.js';

const USAGE = `freebuff-mcp — MCP bridge for locally installed Freebuff Desktop and CLI

Usage:
  freebuff-mcp serve              Run the MCP v2 server over stdio (default)
  freebuff-mcp serve-v1           Run the legacy MCP v1 server over stdio
  freebuff-mcp serve-acp          Run the experimental ACP adapter over stdio
  freebuff-mcp serve-http         Run the authenticated MCP HTTP server
  freebuff-mcp doctor [--json]    Print structured diagnostics (add --json for machine output)
  freebuff-mcp install [codex] [--write]      Configure Codex (default target)
  freebuff-mcp install claude [--write] [--project]   Configure Claude Code
  freebuff-mcp version            Print the package version

Environment:
  FREEBUFF_PROJECT_ROOT           Project root for CLI-mode sessions
  FREEBUFF_MCP_CLI_MODE=pty       Force the CLI PTY backend
  FREEBUFF_ORCHESTRATOR_URL       Explicit Desktop URL (skips discovery)
  FREEBUFF_MCP_HANDOFF_FILE       Explicit Desktop handoff file path
  FREEBUFF_CLI_PATH               Explicit Freebuff CLI executable path
  FREEBUFF_MCP_TOKEN              Bearer token for serve-http`;

interface DoctorReport {
  ok: boolean;
  version: string;
  node: string;
  platform: string;
  arch: string;
  backend: { kind: string; connection: string; authorization: string; liveProgress: string; notes: string[] };
  cli: { installed: boolean; pathBasename?: string };
  desktop: { detected: boolean; authorized: boolean; apiUrlCompatible: boolean; eventStreamState: string };
  capabilities: Record<string, boolean>;
  projectRoot: string;
  pty: { available: boolean; nodePtyVersion: string | null };
  recentErrors: string[];
  handoff?: { path: string; expired: boolean; valid: boolean; reason?: string };
}

async function collectDoctor(): Promise<DoctorReport> {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0]).slice(0, 500)); };

  let desktopDetected = false;
  let desktopAuthorized = false;
  let desktopApiCompatible = false;
  let eventStreamState = 'unavailable';
  let handoffReport: DoctorReport['handoff'];
  const backend: DoctorReport['backend'] = { kind: 'none', connection: 'unavailable', authorization: 'none', liveProgress: 'unavailable', notes: [] };

  try {
    const desktop = new DesktopBackend();
    const caps = await desktop.probe();
    desktopDetected = caps.connection === 'connected_writable' || caps.connection === 'connected_read_only';
    desktopAuthorized = caps.authorization === 'write_authorized';
    desktopApiCompatible = desktopDetected;
    eventStreamState = caps.liveProgress;
    backend.kind = 'desktop';
    backend.connection = caps.connection;
    backend.authorization = caps.authorization;
    backend.liveProgress = caps.liveProgress;
    backend.notes = caps.notes;
    desktop.dispose();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const cliPath = await findFreebuffCli();
  let cliBackend: DoctorReport['backend'] | undefined;
  if (cliPath) {
    try {
      const cli = new CliBackend();
      const caps = await cli.probe();
      cliBackend = { kind: 'cli', connection: caps.connection, authorization: caps.authorization, liveProgress: caps.liveProgress, notes: caps.notes };
      if (backend.kind === 'none') { backend.kind = 'cli'; Object.assign(backend, cliBackend); }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!cliPath && backend.kind === 'none') backend.notes.push('Install Freebuff Desktop or the Freebuff CLI to use this bridge.');

  console.error = originalError;

  const { HANDOFF_ENV, readHandoff } = await import('./desktop/handoff.js');
  const handoff = await readHandoff();
  if (handoff.path) {
    handoffReport = { path: handoff.path, valid: handoff.valid, ...(handoff.reason ? { reason: handoff.reason } : {}), expired: handoff.reason === 'handoff_expired' };
  }

  let ptyVersion: string | null = null;
  try { ptyVersion = await nodePtyVersion(); } catch { ptyVersion = null; }

  const desktopCaps = backend.kind === 'desktop' ? backend : undefined;
  return {
    ok: desktopDetected || Boolean(cliPath),
    version: VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    backend: { ...backend, notes: backend.notes.filter(Boolean) },
    cli: { installed: Boolean(cliPath), ...(cliPath ? { pathBasename: cliPath.split(/[\\/]/).pop() } : {}) },
    desktop: { detected: desktopDetected, authorized: desktopAuthorized, apiUrlCompatible: desktopApiCompatible, eventStreamState },
    capabilities: {
      read: desktopDetected || Boolean(cliPath),
      write: desktopAuthorized || Boolean(cliPath),
      createSession: desktopCaps ? desktopCaps.connection.startsWith('connected') : Boolean(cliPath),
      stop: desktopAuthorized || Boolean(cliPath),
      resume: desktopAuthorized || Boolean(cliPath),
      model: desktopAuthorized || Boolean(cliPath),
      reasoning: desktopAuthorized || Boolean(cliPath),
    },
    projectRoot: process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd(),
    pty: { available: Boolean(cliPath), nodePtyVersion: ptyVersion },
    recentErrors: errors.slice(-5),
    ...(handoffReport ? { handoff: handoffReport } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'serve';
  const flags = argv.slice(1);
  if (command === 'install') {
    const write = flags.includes('--write');
    const target = (flags.find((f) => !f.startsWith('--')) ?? 'codex') as 'codex' | 'claude';
    if (target === 'claude') {
      const scope = flags.includes('--project') ? 'project' : 'user';
      console.log(await installClaude(write, scope));
    } else {
      console.log(await installCodex(write));
      if (!write) console.error("Note: 'freebuff-mcp install' now targets Codex; use 'freebuff-mcp install claude' for Claude Code.");
    }
    return;
  }
  switch (command) {
    case 'serve': await runStdioV2(); return;
    case 'serve-v1': await runStdio(); return;
    case 'serve-acp': await runAcp(); return;
    case 'serve-http': await runHttp(); return;
    case 'version': console.log(VERSION); return;
    case 'doctor': {
      const report = await collectDoctor();
      if (flags.includes('--json')) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`freebuff-mcp ${report.version}`);
        console.log(`Node ${report.node} on ${report.platform}/${report.arch}`);
        console.log(`Backend: ${report.backend.kind} (${report.backend.connection}), authorization: ${report.backend.authorization}, live progress: ${report.backend.liveProgress}`);
        console.log(`Desktop detected: ${report.desktop.detected}, authorized: ${report.desktop.authorized}, event stream: ${report.desktop.eventStreamState}`);
        console.log(`Freebuff CLI: ${report.cli.installed ? `installed (${report.cli.pathBasename})` : 'not found'}`);
        console.log(`PTY: ${report.pty.available ? 'available' : 'unavailable'}${report.pty.nodePtyVersion ? `, node-pty ${report.pty.nodePtyVersion}` : ''}`);
        console.log(`Project root: ${report.projectRoot}`);
        if (report.handoff) console.log(`Handoff: ${report.handoff.valid ? 'valid' : `invalid (${report.handoff.reason ?? 'unknown'})`}${report.handoff.expired ? ' (expired)' : ''} at ${report.handoff.path}`);
        for (const note of report.backend.notes) console.log(`- ${note}`);
        for (const error of report.recentErrors) console.log(`! ${error}`);
        if (!report.ok) { console.error('No Freebuff installation was detected.'); process.exitCode = 1; }
      }
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

await main();

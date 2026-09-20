import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export type InstallTarget = 'codex' | 'claude';

export interface InstallPlan {
  target: InstallTarget;
  /** Human-readable configuration to print when not writing. */
  display: string;
  /** Absolute config path that would be modified. */
  configPath: string;
  /** When true, the tool can append safely without overwriting existing entries. */
  canWrite: boolean;
  /** Reason writing is refused, when applicable. */
  writeRefusal?: string;
}

export function executableCommand(): { command: string; args: string[] } {
  const executable = path.resolve(process.argv[1] ?? 'freebuff-mcp');
  if (process.platform === 'win32' && /\.cmd$/i.test(executable)) {
    return { command: executable, args: ['serve'] };
  }
  return { command: process.execPath, args: [executable, 'serve'] };
}

function tomlQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function codexConfigText(): string {
  const { command, args } = executableCommand();
  const argList = args.map((arg) => tomlQuote(arg)).join(', ');
  return `[mcp_servers.freebuff]
command = ${tomlQuote(command)}
args = [${argList}]
startup_timeout_sec = 20
tool_timeout_sec = 3600
enabled = true
`;
}

export function claudeConfigJson(): string {
  const { command, args } = executableCommand();
  return JSON.stringify({ freebuff: { type: 'stdio', command, args, env: {} } }, null, 2);
}

export function codexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

export function claudeConfigPaths(): { user: string; project: string } {
  return {
    user: path.join(os.homedir(), '.claude.json'),
    project: path.join(process.cwd(), '.mcp.json'),
  };
}

export function planCodexInstall(): InstallPlan {
  const configPath = codexConfigPath();
  return { target: 'codex', display: codexConfigText(), configPath, canWrite: true };
}

export function planClaudeInstall(scope: 'user' | 'project'): InstallPlan {
  const paths = claudeConfigPaths();
  const configPath = scope === 'project' ? paths.project : paths.user;
  return { target: 'claude', display: claudeConfigJson(), configPath, canWrite: true };
}

/**
 * Append the Codex TOML entry unless a freebuff entry already exists.
 * Never modifies an existing entry.
 */
export async function writeCodexConfig(plan: InstallPlan): Promise<{ written: boolean; message: string }> {
  let existing = '';
  try { existing = await fs.readFile(plan.configPath, 'utf8'); } catch { /* create below */ }
  if (/^\[mcp_servers\.freebuff\]/m.test(existing)) {
    return { written: false, message: `An [mcp_servers.freebuff] entry already exists in ${plan.configPath}; no changes made.` };
  }
  await fs.mkdir(path.dirname(plan.configPath), { recursive: true });
  const prefix = existing && !existing.endsWith('\n') ? '\n\n' : '';
  await fs.appendFile(plan.configPath, `${prefix}${plan.display}`, 'utf8');
  return { written: true, message: `Added Freebuff configuration to ${plan.configPath}.` };
}

/**
 * Merge the Claude MCP server into an existing JSON config without corrupting
 * unknown keys. Refuses to overwrite a differing existing `freebuff` entry.
 */
export async function writeClaudeConfig(plan: InstallPlan): Promise<{ written: boolean; message: string }> {
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(plan.configPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch { /* create below */ }
  const mcpServers = (existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers) ? existing.mcpServers : {}) as Record<string, unknown>;
  const parsed = JSON.parse(plan.display) as Record<string, unknown>;
  if (mcpServers.freebuff) {
    const current = JSON.stringify(mcpServers.freebuff);
    const next = JSON.stringify(parsed.freebuff);
    if (current === next) return { written: false, message: `The freebuff entry in ${plan.configPath} already matches; no changes made.` };
    return { written: false, message: `A differing freebuff entry exists in ${plan.configPath}; update it manually or remove it first. No changes made.` };
  }
  mcpServers.freebuff = parsed.freebuff;
  existing.mcpServers = mcpServers;
  await fs.mkdir(path.dirname(plan.configPath), { recursive: true });
  await fs.writeFile(plan.configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return { written: true, message: `Added the freebuff MCP server to ${plan.configPath}.` };
}

import { planClaudeInstall, writeClaudeConfig, InstallPlan } from './common.js';

/**
 * Claude Code installer: print or write the MCP server registration.
 * User scope writes ~/.claude.json; project scope writes ./.mcp.json.
 */
export async function installClaude(write: boolean, scope: 'user' | 'project' = 'user'): Promise<string> {
  const plan: InstallPlan = planClaudeInstall(scope);
  if (!write) {
    const register = scope === 'project'
      ? `claude mcp add --scope project freebuff -- node ${JSON.stringify(process.argv[1] ?? 'freebuff-mcp')} serve`
      : `claude mcp add --scope user freebuff -- node ${JSON.stringify(process.argv[1] ?? 'freebuff-mcp')} serve`;
    return `${register}\n\nOr add this to ${plan.configPath} under "mcpServers":\n\n${plan.display}`;
  }
  const outcome = await writeClaudeConfig(plan);
  return outcome.message;
}

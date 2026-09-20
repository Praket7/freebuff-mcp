import { planCodexInstall, writeCodexConfig, InstallPlan } from './common.js';

/** Codex installer: print or write the ~/.codex/config.toml entry. */
export async function installCodex(write: boolean): Promise<string> {
  const plan: InstallPlan = planCodexInstall();
  if (!write) {
    return `${plan.display}\n# Add the block above to ${plan.configPath}, or run 'freebuff-mcp install codex --write'.`;
  }
  const outcome = await writeCodexConfig(plan);
  return outcome.message;
}

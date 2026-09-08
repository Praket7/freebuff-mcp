#!/usr/bin/env node
import { createServer, runHttp, runStdio } from './mcp.js';
import { detectRuntime, localInstallInfo } from './runtime.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
const command=process.argv[2] ?? 'serve';
function cursorConfigPath(global: boolean): string { return global ? path.join(os.homedir(), '.cursor', 'mcp.json') : path.join(process.cwd(), '.cursor', 'mcp.json'); }
function cursorEntry(global: boolean): Record<string, unknown> { const executable = path.resolve(process.argv[1] ?? 'freebuff-mcp'); return { command: process.execPath, args: [executable, 'serve'], ...(global ? {} : { env: { FREEBUFF_PROJECT_ROOT: process.cwd() } }) }; }
async function installCursor(write: boolean, global: boolean): Promise<void> {
  const target = cursorConfigPath(global); const entry = cursorEntry(global);
  let document: Record<string, any> = { mcpServers: {} };
  try { const parsed = JSON.parse(await fs.readFile(target, 'utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Cursor MCP configuration must be a JSON object'); document = parsed; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!document.mcpServers || typeof document.mcpServers !== 'object' || Array.isArray(document.mcpServers)) throw new Error('Cursor mcpServers must be a JSON object');
  document.mcpServers['freebuff-mcp'] = entry;
  const output = `${JSON.stringify(document, null, 2)}\n`;
  if (!write) { console.log(output); console.log(`Cursor configuration path ${target}`); console.log(`Use 'freebuff-mcp cursor-install --write${global ? ' --global' : ''}' to save it.`); return; }
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.copyFile(target, `${target}.bak`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.writeFile(target, output, 'utf8');
  console.log(`Added freebuff-mcp to ${target}`);
  console.log(`A backup is kept at ${target}.bak when an earlier file existed.`);
}
async function installConfig(write: boolean): Promise<void> {
  const executable = path.resolve(process.argv[1] ?? 'freebuff-mcp');
  const config = `[mcp_servers.freebuff]\ncommand = '${process.execPath.replace(/\\/g, '\\\\')}'\nargs = ['${executable.replace(/\\/g, '\\\\')}', 'serve']\nenabled = true\n\n# Optional CLI PTY mode (use this as a separate entry when needed):\n# [mcp_servers.freebuff_cli]\n# command = '${process.execPath.replace(/\\/g, '\\\\')}'\n# args = ['${executable.replace(/\\/g, '\\\\')}', 'serve']\n# enabled = true\n# [mcp_servers.freebuff_cli.env]\n# FREEBUFF_MCP_CLI_MODE = 'pty'\n`;
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (write) { let existing = ''; try { existing = await fs.readFile(configPath, 'utf8'); } catch { /* create below */ } if (/^\[mcp_servers\.freebuff\]/m.test(existing)) throw new Error(`MCP entry already exists in ${configPath}; no changes made`); await fs.mkdir(path.dirname(configPath), { recursive:true }); await fs.appendFile(configPath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${config}`, 'utf8'); console.log(`Added Desktop-first Freebuff configuration to ${configPath}`); } else { console.log(config); console.log(`Run 'freebuff-mcp install --write' to add it to ${configPath}, then run 'freebuff-mcp doctor'.`); }
}
if(command==='install'){await installConfig(process.argv.includes('--write'));}
else if(command==='cursor-install'){await installCursor(process.argv.includes('--write'), process.argv.includes('--global'));}
else if(command==='doctor'){const r=await detectRuntime();console.log(JSON.stringify({capabilities:await r.capabilities(),installation:await localInstallInfo()},null,2));}
else if(command==='serve'){await runStdio();}
else if(command==='serve-http'){await runHttp();}
else if(command==='version'){console.log('0.1.8');}
else {console.error('Usage: freebuff-mcp [serve|serve-http|doctor|install [--write]|cursor-install [--write] [--global]|version]');process.exitCode=2;}

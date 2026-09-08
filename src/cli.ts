#!/usr/bin/env node
import { createServer, runHttp, runStdio } from './mcp.js';
import { detectRuntime, localInstallInfo } from './runtime.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
const command=process.argv[2] ?? 'serve';
async function installConfig(write: boolean): Promise<void> {
  const executable = path.resolve(process.argv[1] ?? 'freebuff-mcp');
  const config = `[mcp_servers.freebuff]\ncommand = '${process.execPath.replace(/\\/g, '\\\\')}'\nargs = ['${executable.replace(/\\/g, '\\\\')}', 'serve']\nenabled = true\n\n# Optional CLI PTY mode (use this as a separate entry when needed):\n# [mcp_servers.freebuff_cli]\n# command = '${process.execPath.replace(/\\/g, '\\\\')}'\n# args = ['${executable.replace(/\\/g, '\\\\')}', 'serve']\n# enabled = true\n# [mcp_servers.freebuff_cli.env]\n# FREEBUFF_MCP_CLI_MODE = 'pty'\n`;
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (write) { let existing = ''; try { existing = await fs.readFile(configPath, 'utf8'); } catch { /* create below */ } if (/^\[mcp_servers\.freebuff\]/m.test(existing)) throw new Error(`MCP entry already exists in ${configPath}; no changes made`); await fs.mkdir(path.dirname(configPath), { recursive:true }); await fs.appendFile(configPath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${config}`, 'utf8'); console.log(`Added Desktop-first Freebuff configuration to ${configPath}`); } else { console.log(config); console.log(`Run 'freebuff-mcp install --write' to add it to ${configPath}, then run 'freebuff-mcp doctor'.`); }
}
if(command==='install'){await installConfig(process.argv.includes('--write'));}
else if(command==='doctor'){const r=await detectRuntime();console.log(JSON.stringify({capabilities:await r.capabilities(),installation:await localInstallInfo()},null,2));}
else if(command==='serve'){await runStdio();}
else if(command==='serve-http'){await runHttp();}
else if(command==='version'){console.log('0.1.9');}
else {console.error('Usage: freebuff-mcp [serve|serve-http|doctor|install [--write]|version]');process.exitCode=2;}

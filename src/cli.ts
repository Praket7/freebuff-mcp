#!/usr/bin/env node
import { createServer, runStdio } from './mcp.js';
import { detectRuntime, localInstallInfo } from './runtime.js';
const command=process.argv[2] ?? 'serve';
if(command==='install'){console.log('freebuff-mcp is ready. Add this command to your MCP client:');console.log(JSON.stringify({command:'npx',args:['-y','freebuff-mcp@latest']},null,2));console.log('Run `freebuff-mcp doctor` to check the local Freebuff connection.');}
else if(command==='doctor'){const r=await detectRuntime();console.log(JSON.stringify({capabilities:await r.capabilities(),installation:await localInstallInfo()},null,2));}
else if(command==='serve'){await runStdio();}
else if(command==='version'){console.log('0.1.0');}
else {console.error('Usage: freebuff-mcp [serve|doctor|version]');process.exitCode=2;}


import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopOrchestratorRuntime, detectRuntime } from '../src/runtime.js';

test('Desktop runtime probes /api/projects and never infers write authorization from an env var', async () => {
  const previousFetch = globalThis.fetch;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  process.env.FREEBUFF_LAUNCH_ID = 'test-only';
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55354');
    const caps = await runtime.capabilities();
    assert.equal(caps.orchestrator, true);
    assert.equal(caps.readOnly, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID; else process.env.FREEBUFF_LAUNCH_ID = previousLaunch;
  }
});

test('explicit CLI mode takes precedence over Desktop discovery', async () => {
  const previous = process.env.FREEBUFF_MCP_CLI_MODE;
  process.env.FREEBUFF_MCP_CLI_MODE = 'pty';
  try { assert.equal((await detectRuntime()).constructor.name, 'CliPtyRuntime'); }
  finally { if (previous === undefined) delete process.env.FREEBUFF_MCP_CLI_MODE; else process.env.FREEBUFF_MCP_CLI_MODE = previous; }
});


import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopOrchestratorRuntime, detectRuntime, discoverDesktopCandidate } from '../src/runtime.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/mcp.js';

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

test('Desktop runtime enables writes only after /healthz verifies the dynamic launch id', async () => {
  const previousFetch = globalThis.fetch;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  process.env.FREEBUFF_LAUNCH_ID = 'dynamic-launch-id';
  const seen: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/healthz')) { seen.push(String((init?.headers as Record<string, string>)?.['x-freebuff-launch-id'])); return new Response(JSON.stringify({ ok:true }), { status:200 }); }
    if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status:200 });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55354');
    const caps = await runtime.capabilities();
    assert.equal(caps.readOnly, false);
    assert.deepEqual(seen, ['dynamic-launch-id']);
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

test('Desktop runtime rejects malformed project and thread payloads', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [{ path: 42 }, { path: 'C:/valid' }] }), { status: 200 });
    if (url.endsWith('/api/thread/thread-1')) return new Response(JSON.stringify(['not-a-thread']), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55354');
    assert.deepEqual(await runtime.listProjects(), [{ id:'C:/valid', path:'C:/valid', name:'valid', metadata:{path:'C:/valid'} }]);
    await assert.rejects(() => runtime.getThread('thread-1'), /Invalid Freebuff thread response/);
  } finally { globalThis.fetch = previousFetch; }
});

test('read-only servers omit mutation tools', () => {
  const runtime = { capabilities: async () => ({ product:'unknown', signedIn:'unknown', orchestrator:false, readOnly:true, endpoints:[], notes:[] }), listProjects:async()=>[], listThreads:async()=>[], getThread:async()=>({}), getMessages:async()=>[], activeWork:async()=>[], listFiles:async()=>[], readFile:async()=>({path:'',content:''}), sendMessage:async()=>({}), stop:async()=>({}), resume:async()=>({}), listModels:async()=>({}), setModel:async()=>({}), setReasoning:async()=>({}) } as any;
  const tools = Object.keys((createServer(runtime, false) as any)._registeredTools);
  assert.equal(tools.includes('send_message'), false);
  assert.equal(tools.includes('set_model'), false);
});

test('status reports the selected Desktop runtime and live progress', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/api/projects')) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
  try {
    const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55354');
    const caps = await runtime.capabilities();
    assert.equal(caps.status, 'desktop_read_only');
    assert.equal(caps.liveProgress, 'connected');
    assert.equal(caps.selectedRuntime, 'desktop');
  } finally { globalThis.fetch = previousFetch; }
});

test('history search validates query length', async () => {
  const runtime = new DesktopOrchestratorRuntime('http://127.0.0.1:55354');
  await assert.rejects(() => runtime.searchHistory(''), /Query must be 1 to 200/);
});

test('write refreshes authorization after Freebuff rotates its launch ID', async () => {
  const previousFetch = globalThis.fetch; const previousLaunch = process.env.FREEBUFF_LAUNCH_ID; process.env.FREEBUFF_LAUNCH_ID = 'old-launch'; let writes = 0;
  globalThis.fetch = async (input, init) => { const url=String(input); const launch=(init?.headers as Record<string,string> | undefined)?.['x-freebuff-launch-id']; if(url.endsWith('/api/projects')) return new Response(JSON.stringify({projects:[]}),{status:200}); if(url.endsWith('/healthz')) return new Response(JSON.stringify({ok:launch==='old-launch'||launch==='new-launch'}),{status:200}); if(url.endsWith('/api/thread/t/message')) { writes++; if(writes===1){process.env.FREEBUFF_LAUNCH_ID='new-launch'; return new Response('{}',{status:403});} return new Response(JSON.stringify({accepted:true}),{status:200}); } throw new Error(`unexpected ${url}`); };
  try { const runtime=new DesktopOrchestratorRuntime('http://127.0.0.1:55354'); assert.deepEqual(await runtime.sendMessage('t','hello'),{accepted:true}); assert.equal(writes,2); } finally { globalThis.fetch=previousFetch; if(previousLaunch===undefined)delete process.env.FREEBUFF_LAUNCH_ID;else process.env.FREEBUFF_LAUNCH_ID=previousLaunch; }
});

test('stale readiness metadata is ignored', async () => {
  const file=path.join(os.tmpdir(),`freebuff-stale-${Date.now()}-${Math.random()}.json`); const previousFile=process.env.FREEBUFF_READINESS_FILE; const previousFetch=globalThis.fetch; await fs.writeFile(file,JSON.stringify({url:'http://127.0.0.1:55354',launchId:'stale',pid:process.pid,timestamp:new Date(Date.now()-20*60_000).toISOString()})); process.env.FREEBUFF_READINESS_FILE=file; globalThis.fetch=async()=>new Response('{}',{status:503});
  try { assert.equal(await discoverDesktopCandidate(),null); } finally { globalThis.fetch=previousFetch; if(previousFile===undefined)delete process.env.FREEBUFF_READINESS_FILE;else process.env.FREEBUFF_READINESS_FILE=previousFile; await fs.unlink(file).catch(()=>undefined); }
});

test('separate bridge instances refresh independently after a rotation', async () => {
  const previousFetch=globalThis.fetch; const previousLaunch=process.env.FREEBUFF_LAUNCH_ID; process.env.FREEBUFF_LAUNCH_ID='first'; const seen:string[]=[];
  globalThis.fetch=async(input,init)=>{ const url=String(input); const launch=(init?.headers as Record<string,string> | undefined)?.['x-freebuff-launch-id'] ?? ''; if(url.endsWith('/api/projects')){seen.push(launch);return new Response(JSON.stringify({projects:[]}));} if(url.endsWith('/healthz'))return new Response(JSON.stringify({ok:true})); throw new Error('unexpected'); };
  try { const one=new DesktopOrchestratorRuntime('http://127.0.0.1:55354'); await one.capabilities(); process.env.FREEBUFF_LAUNCH_ID='second'; const two=new DesktopOrchestratorRuntime('http://127.0.0.1:55354'); await two.capabilities(); assert.deepEqual(seen,['first','second']); } finally {globalThis.fetch=previousFetch;if(previousLaunch===undefined)delete process.env.FREEBUFF_LAUNCH_ID;else process.env.FREEBUFF_LAUNCH_ID=previousLaunch;}
});

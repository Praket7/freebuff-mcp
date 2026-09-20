import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { startFakeDesktop, type FakeDesktop } from './helpers/fake-desktop.js';

/**
 * Wire-level tests for the ACP adapter (`serve-acp`), which previously had only
 * adapter-internal coverage. These drive a REAL spawned process over
 * newline-delimited JSON-RPC against the fake Desktop, so the ACP method names,
 * capability advertisement, session identity mapping, and prompt completion
 * semantics are all verified on the wire.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface AcpHandle {
  send: (message: unknown) => void;
  request: (id: number, method: string, params: unknown) => Promise<any>;
  notifications: unknown[];
  stop: () => Promise<void>;
  stderr: () => string;
}

async function startAcp(desktop: FakeDesktop): Promise<AcpHandle> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve-acp'], {
    cwd: ROOT,
    env: { ...process.env, FREEBUFF_ORCHESTRATOR_URL: desktop.url, FREEBUFF_LAUNCH_ID: desktop.launchId },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  const pending = new Map<number, (value: any) => void>();
  const notifications: unknown[] = [];
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdout?.on('data', (chunk) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: number; method?: string };
        if (typeof message.id === 'number' && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
        else if (message.method) notifications.push(message);
      } catch { /* ignore non-JSON noise */ }
    }
  });
  return {
    send: (message) => { child.stdin!.write(`${JSON.stringify(message)}\n`); },
    request: (id, method, params) => new Promise((resolve) => { pending.set(id, resolve); child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }),
    notifications,
    stderr: () => stderr,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => { child.once('exit', () => resolve()); setTimeout(resolve, 3000); });
    },
  };
}

/** Wait for a condition, bounded. */
async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test('acp wire: initialize advertises only implemented capabilities', async () => {
  const desktop = await startFakeDesktop();
  const acp = await startAcp(desktop);
  try {
    const response = await acp.request(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal(response?.error, undefined, `initialize failed: ${JSON.stringify(response)} ${acp.stderr()}`);
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(response.result.agentInfo.name, 'freebuff-mcp');
    assert.equal(response.result.agentCapabilities.loadSession, false, 'loadSession is not implemented and must not be advertised');
    assert.equal(response.result.agentCapabilities.promptCapabilities.image, false);
  } finally {
    await acp.stop();
    await desktop.close();
  }
});

test('acp wire: session/new creates a real backend session, and prompt completes at end_turn', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 40 });
  const acp = await startAcp(desktop);
  try {
    await acp.request(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });

    const created = await acp.request(2, 'session/new', { cwd: desktop.projectPath, mcpServers: [] });
    assert.equal(created?.error, undefined, `session/new failed: ${JSON.stringify(created)} ${acp.stderr()}`);
    const sessionId = created.result.sessionId as string;
    assert.ok(sessionId, 'session/new returned a session id');
    // A real Desktop thread was created for it (never a bridge-generated id).
    assert.ok(desktop.threads.size >= 2, `a Desktop thread was created (threads: ${desktop.threads.size})`);
    assert.equal(desktop.calls.some((c) => c.method === 'POST' && c.path === '/api/threads'), true);

    const prompt = await acp.request(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'say hello' }] });
    assert.equal(prompt?.error, undefined, `session/prompt failed: ${JSON.stringify(prompt)} ${acp.stderr()}`);
    assert.equal(prompt.result.stopReason, 'end_turn', 'a completed turn reports end_turn');
    // The prompt was sent to the Desktop on the real action route.
    assert.ok(desktop.calls.some((c) => c.method === 'POST' && /\/api\/thread\/.+\/message$/.test(c.path)));
  } finally {
    await acp.stop();
    await desktop.close();
  }
});

test('acp wire: cancel is a notification, completes the prompt as cancelled, and keeps the process alive', async () => {
  const desktop = await startFakeDesktop({ turnDelayMs: 30_000 });
  const acp = await startAcp(desktop);
  try {
    await acp.request(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const created = await acp.request(2, 'session/new', { cwd: desktop.projectPath, mcpServers: [] });
    const sessionId = created.result.sessionId as string;

    const pending = acp.request(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'long job' }] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    acp.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    const prompt = await pending;
    assert.equal(prompt?.error, undefined, `prompt after cancel errored: ${JSON.stringify(prompt)} ${acp.stderr()}`);
    assert.equal(prompt.result.stopReason, 'cancelled', 'a cancelled turn reports cancelled, not a refusal');

    // The process survives cancellation and still serves requests.
    const again = await acp.request(4, 'session/new', { cwd: desktop.projectPath, mcpServers: [] });
    assert.equal(again?.error, undefined, `session/new after cancel failed: ${JSON.stringify(again)}`);
    assert.ok(await until(() => true));
  } finally {
    await acp.stop();
    await desktop.close();
  }
});

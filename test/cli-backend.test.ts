import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliBackend } from '../src/backends/cli-backend.js';
import { verifyConversationIdShape } from '../src/pty.js';
import { BridgeError, ErrorCodes } from '../src/bridge/types.js';

test('cli backend: create-session with an unknown id fails with a structured error and never launches a PTY', async () => {
  const backend = new CliBackend('/tmp/definitely-not-a-project');
 // With no CLI binary (CI): FREEBUFF_CLI_NOT_INSTALLED. With a CLI installed
  // (dev machines): the unverified conversation id is refused before launch.
  await assert.rejects(
    () => backend.createSession({ cwd: '/tmp/definitely-not-a-project', continueBackendId: 'made-up-id' }),
    (error: unknown) => error instanceof BridgeError && [ErrorCodes.CLI_NOT_INSTALLED as string, ErrorCodes.INVALID_INPUT as string].includes(error.code),
  );
});

test('cli backend: probe distinguishes a missing binary from authentication', async () => {
  const backend = new CliBackend('/tmp/definitely-not-a-project');
  const caps = await backend.probe();
  // probe() never throws: without a binary it reports not_installed (never
  // "not authenticated", which would send users down the wrong recovery path).
  assert.ok(['cli_ready', 'not_installed'].includes(caps.connection));
  if (caps.connection === 'not_installed') {
    assert.equal(caps.authorization, 'none');
    assert.equal(caps.canSendMessage, false);
  } else {
    // A present binary is NOT proof of login: authorization stays unknown
    // until a PTY session actually succeeds.
    assert.equal(caps.authorization, 'unknown');
  }
  assert.equal(caps.liveProgress, 'unavailable');
});

test('cli backend: writes are authorized only after a PTY session succeeds', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-cli-bin-'));
  const bin = path.join(dir, process.platform === 'win32' ? 'freebuff.exe' : 'freebuff');
  await fs.writeFile(bin, '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') await fs.chmod(bin, 0o755);
  const previous = process.env.FREEBUFF_CLI_PATH;
  process.env.FREEBUFF_CLI_PATH = bin;
  try {
    const backend = new CliBackend('/tmp/project');
    assert.equal((await backend.probe()).authorization, 'unknown', 'binary present but no session yet');
    (backend as unknown as { manager: unknown }).manager = {
      start: async (id: string) => ({ id, pid: 1, output: 'Enter a coding task', exited: false }),
      send: async (id: string) => ({ id, pid: 1, output: 'ok', exited: false }),
      snapshot: (id: string) => ({ id, pid: 1, output: '', exited: false }),
      dispose: () => undefined,
    };
    await backend.createSession({ cwd: '/tmp/project' });
    assert.equal((await backend.probe()).authorization, 'write_authorized', 'a successful PTY start proves login');
  } finally {
    if (previous === undefined) delete process.env.FREEBUFF_CLI_PATH; else process.env.FREEBUFF_CLI_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

interface StubCall { id: string; text: string; cwd: string; conversationId?: string }

/**
 * Replace the PTY manager with a recorder. The CLI backend advertises
 * canSetModel/canSetReasoning, so those methods must exist and must use the
 * harness slash commands rather than silently doing nothing.
 */
function stubManager(backend: CliBackend, exited = false): StubCall[] {
  const calls: StubCall[] = [];
  (backend as unknown as { manager: unknown }).manager = {
    send: async (id: string, text: string, cwd: string, conversationId?: string) => {
      calls.push({ id, text, cwd, ...(conversationId ? { conversationId } : {}) });
      return { id, ...(conversationId ? { conversationId } : {}), pid: process.pid, output: 'stub output', exited };
    },
    dispose: () => undefined,
  };
  return calls;
}

test('cli backend: advertised model and reasoning capabilities are actually implemented', async () => {
  const backend = new CliBackend('/tmp/project');
  const caps = await backend.probe();
  // A capability that is reported must exist: advertising canSetModel without a
  // setModel implementation is what this guards against.
  for (const [capability, method] of [['canSetModel', 'setModel'], ['canSetReasoning', 'setReasoning']] as const) {
    if (caps[capability]) {
      assert.equal(typeof (backend as unknown as Record<string, unknown>)[method], 'function', `${capability} implies ${method}()`);
    }
  }

  const calls = stubManager(backend);
  const session = { id: 'pty-1', backend: 'cli' as const, backendSessionId: '8f0c1e2a-1234-5678-9abc-def012345678', cwd: '/tmp/project' };
  await backend.setModel(session, 'z-ai/glm-5.3-flash');
  await backend.setReasoning(session, 'high');
  assert.deepEqual(calls.map((c) => c.text), ['/model z-ai/glm-5.3-flash', '/reasoning high']);
  assert.ok(calls.every((c) => c.conversationId === session.backendSessionId), 'the verified conversation id is preserved');
});

test('cli backend: model changes fail loudly when the CLI exits', async () => {
  const backend = new CliBackend('/tmp/project');
  stubManager(backend, true);
  const session = { id: 'pty-1', backend: 'cli' as const, backendSessionId: '8f0c1e2a-1234-5678-9abc-def012345678', cwd: '/tmp/project' };
  await assert.rejects(
    () => backend.setModel(session, 'some/model'),
    (error: unknown) => error instanceof BridgeError && error.code === ErrorCodes.BACKEND_UNAVAILABLE,
  );
  await assert.rejects(
    () => backend.setReasoning(session, null),
    (error: unknown) => error instanceof BridgeError && error.code === ErrorCodes.BACKEND_UNAVAILABLE,
  );
  await assert.rejects(() => backend.setModel(session, ''), (error: unknown) => error instanceof BridgeError && error.code === ErrorCodes.INVALID_INPUT);
});

test('conversation id shape validation accepts real CLI ids and rejects traversal', () => {
  assert.equal(verifyConversationIdShape('8f0c1e2a-1234-5678-9abc-def012345678'), true);
  assert.equal(verifyConversationIdShape('chat_2026-09-19'), true);
  assert.equal(verifyConversationIdShape('../escape'), false);
  assert.equal(verifyConversationIdShape('bad id with spaces'), false);
});

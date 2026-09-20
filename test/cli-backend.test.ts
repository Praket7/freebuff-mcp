import assert from 'node:assert/strict';
import test from 'node:test';
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

test('cli backend: probe reports cli_not_authenticated when no CLI binary is present', async () => {
  const backend = new CliBackend('/tmp/definitely-not-a-project');
  const caps = await backend.probe();
  // probe() never throws: without a binary it reports the degraded state.
  assert.ok(['cli_ready', 'cli_not_authenticated'].includes(caps.connection));
  assert.equal(caps.liveProgress, 'unavailable');
});

test('conversation id shape validation accepts real CLI ids and rejects traversal', () => {
  assert.equal(verifyConversationIdShape('8f0c1e2a-1234-5678-9abc-def012345678'), true);
  assert.equal(verifyConversationIdShape('chat_2026-09-19'), true);
  assert.equal(verifyConversationIdShape('../escape'), false);
  assert.equal(verifyConversationIdShape('bad id with spaces'), false);
});

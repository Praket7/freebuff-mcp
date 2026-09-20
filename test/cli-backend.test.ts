import assert from 'node:assert/strict';
import test from 'node:test';
import { CliBackend } from '../src/backends/cli-backend.js';
import { verifyConversationIdShape } from '../src/pty.js';

test('cli backend: refuses to continue an unverified conversation id', async () => {
  const backend = new CliBackend('/tmp/definitely-not-a-project');
  // Even if the CLI were installed, an unknown id must be rejected before PTY launch.
  await assert.rejects(
    () => backend.createSession({ cwd: '/tmp/definitely-not-a-project', continueBackendId: 'made-up-id' }),
    (error: unknown) => (error instanceof Error) && /not a verified Freebuff conversation/i.test(error.message),
  );
});

test('conversation id shape validation accepts real CLI ids and rejects traversal', () => {
  assert.equal(verifyConversationIdShape('8f0c1e2a-1234-5678-9abc-def012345678'), true);
  assert.equal(verifyConversationIdShape('chat_2026-09-19'), true);
  assert.equal(verifyConversationIdShape('../escape'), false);
  assert.equal(verifyConversationIdShape('bad id with spaces'), false);
});

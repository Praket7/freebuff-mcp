import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSafeId, blocked, redact, safeProjectPath, safeTextContent } from '../src/security.js';
import { describePtyLaunchError } from '../src/pty.js';

test('rejects traversal-like identifiers', () => assert.throws(() => assertSafeId('../secret')));
test('accepts opaque thread ids', () => assert.equal(assertSafeId('thread_123:abc'), 'thread_123:abc'));
test('adds actionable diagnostics for posix_spawnp failures', () => {
  assert.match(describePtyLaunchError(new Error('posix_spawnp failed'), '/bin/echo', '/tmp').message, /executable.*interpreter.*node-pty/i);
});
test('redacts secrets in strings and rejects unsafe file content', () => {
  assert.doesNotMatch(String(redact('authorization=secret')), /secret/);
  assert.throws(() => safeTextContent(Buffer.from('a\0b'), 'x.bin'), /Binary/);
  assert.throws(() => safeTextContent(Buffer.alloc(1_000_001), 'x'), /1 MB/);
});
test('protected file rules cover common credential files and directories', () => {
  for (const name of ['.git-credentials', '.aws', '.ssh', '.gnupg', '.azure', '.kube', '.docker', '.npmrc', 'id_ed25519', 'client.pem']) {
    assert.equal(blocked.test(name), true, `${name} should be protected`);
  }
});
test('safeProjectPath refuses secret-bearing directories inside a project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-security-'));
  try {
    const file = path.join(root, '.aws', 'credentials');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'aws_access_key_id = secret', 'utf8');
    await assert.rejects(() => safeProjectPath(root, '.aws/credentials'), /Protected file access denied/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

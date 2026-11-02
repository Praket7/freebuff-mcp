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
test('redacts password lines, PEM keys, nested transcript text, errors, and URLs while keeping useful text', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PEM_SECRET\n-----END PRIVATE KEY-----';
  const text = safeTextContent(Buffer.from(`Notes remain readable\npassword=SYNTHETIC_PASSWORD\n${pem}\nDone`), 'notes.txt');
  assert.match(text, /Notes remain readable/);
  assert.match(text, /Done/);
  assert.doesNotMatch(text, /SYNTHETIC_(PASSWORD|PEM_SECRET)/);
  const clean = redact({ messages: [{ text: 'passwd: SYNTHETIC_PASSWD' }], error: 'password=SYNTHETIC_ERROR', url: 'https://example.test/?pwd=SYNTHETIC_URL' });
  assert.doesNotMatch(JSON.stringify(clean), /SYNTHETIC_(PASSWD|ERROR|URL)/);
});
test('redacts prefixed credential keys and quoted values containing spaces without leaking suffixes', () => {
  const secrets = [
    'OPENAI_API_KEY=SYNTHETIC_OPENAI_KEY',
    'AWS_SECRET_ACCESS_KEY=SYNTHETIC_AWS_SECRET',
    'GITHUB_TOKEN=SYNTHETIC_GITHUB_TOKEN',
    'password = "SYNTHETIC_PASSWORD with spaces"',
    '"client_secret": "SYNTHETIC_CLIENT_SECRET with spaces",',
    'note=value with spaces',
  ].join('\n');
  const clean = safeTextContent(Buffer.from(secrets), 'config.example');
  assert.doesNotMatch(clean, /SYNTHETIC_/);
  assert.match(clean, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(clean, /AWS_SECRET_ACCESS_KEY=\[REDACTED\]/);
  assert.match(clean, /GITHUB_TOKEN=\[REDACTED\]/);
  assert.match(clean, /password\s*=\s*"\[REDACTED\]"/);
  assert.match(clean, /"client_secret": "\[REDACTED\]",/);
  assert.match(clean, /note=value with spaces/);
  const structured = redact({ OPENAI_API_KEY: 'SYNTHETIC_OBJECT_KEY', AWS_SECRET_ACCESS_KEY: 'SYNTHETIC_OBJECT_SECRET' });
  assert.doesNotMatch(JSON.stringify(structured), /SYNTHETIC_/);
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

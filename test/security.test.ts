import test from 'node:test'; import assert from 'node:assert/strict'; import { assertSafeId } from '../src/security.js'; import { describePtyLaunchError } from '../src/pty.js';
test('rejects traversal-like identifiers',()=>assert.throws(()=>assertSafeId('../secret')));
test('accepts opaque thread ids',()=>assert.equal(assertSafeId('thread_123:abc'),'thread_123:abc'));
test('adds actionable diagnostics for posix_spawnp failures', () => { assert.match(describePtyLaunchError(new Error('posix_spawnp failed'), '/bin/echo', '/tmp').message, /executable.*interpreter.*node-pty/i); });

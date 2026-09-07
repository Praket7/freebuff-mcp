import test from 'node:test'; import assert from 'node:assert/strict'; import { assertSafeId } from '../src/security.js';
test('rejects traversal-like identifiers',()=>assert.throws(()=>assertSafeId('../secret')));
test('accepts opaque thread ids',()=>assert.equal(assertSafeId('thread_123:abc'),'thread_123:abc'));


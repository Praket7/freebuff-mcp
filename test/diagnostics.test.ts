import assert from 'node:assert/strict';
import test from 'node:test';
import { anyBackendCapability } from '../src/diagnostics.js';

test('doctor capability merge lets a writable CLI fallback override a false Desktop capability', () => {
  assert.equal(anyBackendCapability(false, true), true);
  assert.equal(anyBackendCapability(undefined, true), true);
  assert.equal(anyBackendCapability(false, false), false);
  assert.equal(anyBackendCapability(undefined, undefined), false);
});

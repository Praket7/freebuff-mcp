import assert from 'node:assert/strict';
import test from 'node:test';
import { CompositeBackend } from '../src/backends/backend.js';
import { DesktopBackend } from '../src/backends/desktop-backend.js';
import { CliBackend } from '../src/backends/cli-backend.js';
import { classifyPhase } from '../src/desktop/event-adapter.js';
import { mapDesktopEvent } from '../src/desktop/event-adapter.js';

void DesktopBackend;
void CliBackend;
void CompositeBackend;

test('phase classification: tool-based phases are structural, not guessed', () => {
  assert.equal(classifyPhase('tool_start', 'read_files'), 'reading_files');
  assert.equal(classifyPhase('tool_start', 'code_search'), 'reading_files');
  assert.equal(classifyPhase('tool_start', 'change_file'), 'editing_files');
  assert.equal(classifyPhase('tool_start', 'apply_patch'), 'editing_files');
  assert.equal(classifyPhase('tool_start', 'run_terminal_command', 'pnpm build'), 'running_command');
});

test('phase classification: only actual test commands are running_tests', () => {
  assert.equal(classifyPhase('tool_start', 'run_terminal_command', 'pnpm test'), 'running_tests');
  assert.equal(classifyPhase('tool_start', 'run_terminal_command', 'npm run test'), 'running_tests');
  assert.equal(classifyPhase('tool_start', 'run_terminal_command', 'pytest -q'), 'running_tests');
  assert.equal(classifyPhase('tool_start', 'run_terminal_command', 'cargo test'), 'running_tests');
  assert.equal(classifyPhase('tool_start', 'run_terminal_command', 'go test ./...'), 'running_tests');
  assert.notEqual(classifyPhase('tool_start', 'run_terminal_command', 'git status'), 'running_tests');
  assert.notEqual(classifyPhase('tool_start', 'run_terminal_command', 'npm install'), 'running_tests');
  assert.notEqual(classifyPhase('tool_start', 'run_terminal_command', 'mkdir -p build'), 'running_tests');
  assert.notEqual(classifyPhase('tool_start', 'run_terminal_command', 'python script.py'), 'running_tests');
});

test('desktop event mapping: types map to bridge events without fabricating text', () => {
  const mapped = mapDesktopEvent({ threadId: 'th1', type: 'assistant_update', text: 'partial answer' }, undefined);
  assert.equal(mapped?.type, 'assistant_delta');
  assert.equal(mapped?.message, 'partial answer');
  const completed = mapDesktopEvent({ threadId: 'th1', type: 'completed' }, undefined);
  assert.equal(completed?.type, 'completed');
  const reasoning = mapDesktopEvent({ threadId: 'th1', type: 'reasoning_update', text: 'secret thoughts' }, undefined);
  assert.equal(reasoning, null, 'reasoning traces are dropped');
  const threadless = mapDesktopEvent({ type: 'completed' }, undefined);
  assert.equal(threadless, null);
});

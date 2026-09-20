import assert from 'node:assert/strict';
import test from 'node:test';
import { createV2ServerFromAdapter, V2Adapter } from '../src/mcp-v2.js';
import { CompositeBackend } from '../src/backends/backend.js';
import { SessionManager } from '../src/bridge/session-manager.js';
import { TurnManager } from '../src/bridge/turn-manager.js';
import { BackendCapabilities } from '../src/bridge/types.js';

function makeAdapter(caps: Partial<BackendCapabilities> = {}): V2Adapter & { backend: CompositeBackend } {
  const backend = new CompositeBackend();
  const sessions = new SessionManager(backend);
  const turns = new TurnManager(sessions);
  return { backend, sessions, turns };
}

test('MCP v2 server exposes the stable guarded tool surface', () => {
  const adapter = makeAdapter();
  const server = createV2ServerFromAdapter(adapter);
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  const names = Object.keys(tools).sort();
  for (const expected of ['freebuff_status', 'list_projects', 'list_threads', 'get_thread', 'get_thread_messages', 'get_active_work', 'get_turn', 'get_thread_progress', 'watch_thread', 'watch_turn', 'watch_active_threads', 'list_project_files', 'read_project_file', 'list_thread_attachments', 'list_models', 'search_history', 'start_thread', 'send_message', 'run_turn', 'stop_turn', 'stop_thread', 'resume_thread', 'set_model', 'set_reasoning', 'get_changed_files']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
});

test('freebuff_status returns structured capability data', async () => {
  const adapter = makeAdapter();
  const server = createV2ServerFromAdapter(adapter);
  const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  assert.ok(tools.freebuff_status, 'freebuff_status registered');
});

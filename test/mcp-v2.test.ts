import assert from 'node:assert/strict';
import test from 'node:test';
import { createV2Server } from '../src/mcp-v2.js';

test('MCP v2 keeps read and write parity for a writable runtime', () => {
  const runtime = {
    capabilities: async () => ({ product: 'desktop', signedIn: 'unknown', orchestrator: true, readOnly: false, endpoints: [], actions: { sendMessage: true, stop: true, resume: true, setModel: true, setReasoning: true } }),
    listProjects: async () => [], listThreads: async () => [], getThread: async () => ({}), getMessages: async () => [], activeWork: async () => [],
    getThreadProgress: async () => ({ threadId: 't', events: [], connected: true, stale: false }), watchThread: async () => ({ threadId: 't', events: [], connected: true, stale: false }), getThreadProgressSummary: async () => ({ threadId: 't', events: [], connected: true, stale: false }), watchActiveThreads: async () => [],
    listFiles: async () => [], readFile: async () => ({ path: 'x', content: '' }), listAttachments: async () => [], listModels: async () => ({}), searchHistory: async () => [],
    sendMessage: async () => ({}), stop: async () => ({}), resume: async () => ({}), setModel: async () => ({}), setReasoning: async () => ({}),
  } as any;
  const names = Object.keys((createV2Server(runtime, { product: 'desktop', signedIn: 'unknown', orchestrator: true, readOnly: false, endpoints: [], actions: { sendMessage: true, stop: true, resume: true, setModel: true, setReasoning: true } }) as any)._registeredTools);
  assert.deepEqual(names.sort(), ['freebuff_status', 'list_projects', 'list_threads', 'get_thread', 'get_thread_messages', 'get_active_work', 'get_thread_progress', 'watch_thread', 'get_thread_progress_summary', 'watch_active_threads', 'list_project_files', 'read_project_file', 'list_thread_attachments', 'list_models', 'search_history', 'send_message', 'stop_thread', 'resume_thread', 'set_model', 'set_reasoning'].sort());
});

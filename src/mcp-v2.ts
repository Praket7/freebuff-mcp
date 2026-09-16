import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { detectRuntime, Runtime } from './runtime.js';
import { Capabilities, Json } from './types.js';

const VERSION = '0.1.17';
const json = (value: unknown): Json => value as Json;
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: json(value) });
const id = z.string().min(1).max(200);
type Shape = any;
type Handler = (args: any) => Promise<unknown>;

export function createV2Server(runtime: Runtime, capabilities?: Capabilities): McpServer {
  const server = new McpServer({ name: 'freebuff-mcp', version: VERSION, description: 'Freebuff MCP v2 interoperability surface' });
  const read = (name: string, description: string, inputSchema: Shape, fn: Handler) => server.registerTool(name, { description, inputSchema: z.object(inputSchema) as any, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (args: any) => result(await fn(args)));
  const write = (name: string, description: string, inputSchema: Shape, fn: Handler) => server.registerTool(name, { description, inputSchema: z.object(inputSchema) as any, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async (args: any) => result(await fn(args)));

  read('freebuff_status', 'Detect Freebuff and bridge capabilities.', {}, () => runtime.capabilities());
  read('list_projects', 'List discovered Freebuff projects.', {}, () => runtime.listProjects());
  read('list_threads', 'List Freebuff threads.', { projectId: id.optional() }, args => runtime.listThreads(args.projectId));
  read('get_thread', 'Read thread metadata.', { threadId: id }, args => runtime.getThread(args.threadId));
  read('get_thread_messages', 'Read visible thread messages.', { threadId: id }, args => runtime.getMessages(args.threadId));
  read('get_active_work', 'Read visible active work.', { threadId: id.optional() }, args => runtime.activeWork(args.threadId));
  read('get_thread_progress', 'Read bounded live thread progress.', { threadId: id, afterSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }, args => runtime.getThreadProgress(args.threadId, args.afterSequence, args.limit));
  read('watch_thread', 'Wait up to 30 seconds for live thread progress.', { threadId: id, afterSequence: z.number().int().nonnegative().optional(), timeoutMs: z.number().int().min(0).max(30000).optional(), limit: z.number().int().min(1).max(100).optional() }, args => runtime.watchThread(args.threadId, args.afterSequence, args.timeoutMs, args.limit));
  read('get_thread_progress_summary', 'Read a compact live thread progress summary.', { threadId: id }, args => runtime.getThreadProgressSummary(args.threadId));
  read('watch_active_threads', 'Read compact progress summaries for active threads.', {}, () => runtime.watchActiveThreads());
  read('list_project_files', 'List safe files in a project.', { projectId: id, relative: z.string().optional() }, args => runtime.listFiles(args.projectId, args.relative));
  read('read_project_file', 'Read one safe project file.', { projectId: id, path: z.string() }, args => runtime.readFile(args.projectId, args.path));
  read('list_thread_attachments', 'List safe attachment metadata for a thread.', { threadId: id }, args => runtime.listAttachments(args.threadId));
  read('list_models', 'List available model information.', {}, () => runtime.listModels());
  read('search_history', 'Search visible Freebuff history.', { query: z.string().min(1).max(200) }, args => runtime.searchHistory(args.query));

  const actions = capabilities?.actions ?? { sendMessage: !capabilities?.readOnly, stop: !capabilities?.readOnly, resume: !capabilities?.readOnly, setModel: !capabilities?.readOnly, setReasoning: !capabilities?.readOnly };
  if (actions.sendMessage) write('send_message', 'Send a text prompt to an existing Freebuff thread.', { threadId: id, text: z.string().min(1).max(100000) }, args => runtime.sendMessage(args.threadId, args.text));
  if (actions.stop) write('stop_thread', 'Stop a running Freebuff turn.', { threadId: id }, args => runtime.stop(args.threadId));
  if (actions.resume) write('resume_thread', 'Resume a paused Freebuff thread.', { threadId: id }, args => runtime.resume(args.threadId));
  if (actions.setModel) write('set_model', 'Set the model for an existing thread.', { threadId: id, model: z.string().min(1).max(200), harnessId: z.string().optional() }, args => runtime.setModel(args.threadId, args.model, args.harnessId));
  if (actions.setReasoning) write('set_reasoning', 'Set reasoning effort for an existing thread.', { threadId: id, effort: z.string().nullable() }, args => runtime.setReasoning(args.threadId, args.effort));

  server.registerResource('projects', 'freebuff://projects', { title: 'Freebuff projects', description: 'Current project snapshots', mimeType: 'application/json' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.listProjects()) }] }));
  server.registerResource('project-threads', new ResourceTemplate('freebuff://project/{projectId}/threads', { list: undefined }), { title: 'Project threads', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.listThreads(String(variables.projectId))) }] }));
  server.registerResource('thread', new ResourceTemplate('freebuff://thread/{threadId}', { list: undefined }), { title: 'Freebuff thread', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.getThread(String(variables.threadId))) }] }));
  server.registerResource('thread-messages', new ResourceTemplate('freebuff://thread/{threadId}/messages', { list: undefined }), { title: 'Thread messages', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.getMessages(String(variables.threadId))) }] }));
  server.registerResource('thread-progress', new ResourceTemplate('freebuff://thread/{threadId}/progress', { list: undefined }), { title: 'Thread progress', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.getThreadProgressSummary(String(variables.threadId))) }] }));
  runtime.onProgress?.(threadId => { void server.server.sendResourceUpdated({ uri: `freebuff://thread/${encodeURIComponent(threadId)}/progress` }); });
  return server;
}

export async function runStdioV2(): Promise<void> {
  const runtime = await detectRuntime();
  const capabilities = await runtime.capabilities();
  const handle = serveStdio(() => createV2Server(runtime, capabilities), { legacy: 'serve', maxSubscriptions: 64, onerror: error => console.error(error.message) });
  const cleanup = () => { runtime.dispose?.(); void handle.close(); };
  process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup); process.once('exit', cleanup);
}

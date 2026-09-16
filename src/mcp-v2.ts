import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { detectRuntime, Runtime } from './runtime.js';
import { Json } from './types.js';

const json = (value: unknown): Json => value as Json;
const textResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: json(value) });
const id = z.string().min(1).max(200);

export function createV2Server(runtime: Runtime): McpServer {
  const server = new McpServer({ name: 'freebuff-mcp', version: '0.1.16', description: 'Freebuff MCP v2 interoperability surface' });
  const read = (name: string, description: string, inputSchema: z.ZodObject<any>, fn: (args: any) => Promise<unknown>) => server.registerTool(name, { description, inputSchema }, async args => textResult(await fn(args)));

  read('freebuff_status', 'Detect Freebuff and bridge capabilities.', z.object({}), () => runtime.capabilities());
  read('list_projects', 'List discovered Freebuff projects.', z.object({}), () => runtime.listProjects());
  read('list_threads', 'List Freebuff threads.', z.object({ projectId: id.optional() }), args => runtime.listThreads(args.projectId));
  read('get_thread', 'Read thread metadata.', z.object({ threadId: id }), args => runtime.getThread(args.threadId));
  read('get_thread_messages', 'Read visible thread messages.', z.object({ threadId: id }), args => runtime.getMessages(args.threadId));
  read('get_thread_progress', 'Read bounded live thread progress.', z.object({ threadId: id, afterSequence: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }), args => runtime.getThreadProgress(args.threadId, args.afterSequence, args.limit));
  read('list_models', 'List available model information.', z.object({}), () => runtime.listModels());

  server.registerResource('projects', 'freebuff://projects', { title: 'Freebuff projects', description: 'Current project snapshots', mimeType: 'application/json' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.listProjects()) }] }));
  server.registerResource('project-threads', new ResourceTemplate('freebuff://project/{projectId}/threads', { list: undefined }), { title: 'Project threads', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.listThreads(String(variables.projectId))) }] }));
  server.registerResource('thread', new ResourceTemplate('freebuff://thread/{threadId}', { list: undefined }), { title: 'Freebuff thread', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.getThread(String(variables.threadId))) }] }));
  server.registerResource('thread-messages', new ResourceTemplate('freebuff://thread/{threadId}/messages', { list: undefined }), { title: 'Thread messages', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.getMessages(String(variables.threadId))) }] }));
  server.registerResource('thread-progress', new ResourceTemplate('freebuff://thread/{threadId}/progress', { list: undefined }), { title: 'Thread progress', mimeType: 'application/json' }, async (uri, variables) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await runtime.getThreadProgressSummary(String(variables.threadId))) }] }));

  const caps = runtime.capabilities();
  void caps;
  return server;
}

export async function runStdioV2(): Promise<void> {
  const runtime = await detectRuntime();
  const handle = serveStdio(() => createV2Server(runtime), { legacy: 'serve', maxSubscriptions: 64, onerror: error => console.error(error.message) });
  const cleanup = () => { runtime.dispose?.(); void handle.close(); };
  process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup); process.once('exit', cleanup);
}

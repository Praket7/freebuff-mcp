import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { detectRuntime, Runtime } from './runtime.js';

export function createServer(runtime: Runtime, includeWrites = true): McpServer { const s=new McpServer({name:'freebuff-mcp',version:'0.1.8'});
  const read=(name:string,description:string,schema:Record<string,z.ZodType>,fn:(a:any)=>Promise<unknown>)=>s.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:true,openWorldHint:false}},async(a)=>({content:[{type:'text',text:JSON.stringify(await fn(a),null,2)}]}));
  read('freebuff_status','Detect Freebuff and bridge capabilities.',{},()=>runtime.capabilities());
  read('list_projects','List discovered Freebuff projects.',{},()=>runtime.listProjects());
  read('list_threads','List Freebuff Desktop threads.',{projectId:z.string().optional()},(a)=>runtime.listThreads(a.projectId));
  read('get_thread','Read thread metadata.',{threadId:z.string()},(a)=>runtime.getThread(a.threadId));
  read('get_thread_messages','Read visible messages for a thread.',{threadId:z.string()},(a)=>runtime.getMessages(a.threadId));
  read('get_active_work','Read visible active work.',{threadId:z.string().optional()},(a)=>runtime.activeWork(a.threadId));
  read('get_thread_progress','Read live Desktop progress events for a thread. Results are bounded and read-only.',{threadId:z.string(),afterSequence:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()},(a)=>runtime.getThreadProgress(a.threadId,a.afterSequence,a.limit));
  read('watch_thread','Wait up to 30 seconds for live progress events, then return the bounded read-only snapshot.',{threadId:z.string(),afterSequence:z.number().int().nonnegative().optional(),timeoutMs:z.number().int().min(0).max(30000).optional(),limit:z.number().int().min(1).max(100).optional()},(a)=>runtime.watchThread(a.threadId,a.afterSequence,a.timeoutMs,a.limit));
  read('get_thread_progress_summary','Return a simple user-facing live progress summary without raw event details.',{threadId:z.string()},(a)=>runtime.getThreadProgressSummary(a.threadId));
  read('watch_active_threads','Return the latest live progress summary for each active Desktop thread.',{},()=>runtime.watchActiveThreads());
  read('list_project_files','List safe project files.',{projectId:z.string(),relative:z.string().optional()},(a)=>runtime.listFiles(a.projectId,a.relative));
  read('read_project_file','Read one safe project file.',{projectId:z.string(),path:z.string()},(a)=>runtime.readFile(a.projectId,a.path));
  read('list_thread_attachments','List safe attachment metadata for a thread.',{threadId:z.string()},(a)=>runtime.listAttachments(a.threadId));
  read('list_models','List models exposed by the installed bridge.',{},()=>runtime.listModels());
  read('search_history','Search visible Freebuff history without exposing protected content.',{query:z.string().min(1).max(200)},(a)=>runtime.searchHistory(a.query));
  if (!includeWrites) return s;
  const write=(name:string,description:string,schema:Record<string,z.ZodType>,fn:(a:any)=>Promise<unknown>)=>s.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},async(a)=>({content:[{type:'text',text:JSON.stringify(await fn(a),null,2)}]}));
  write('send_message','Send a text prompt to an existing Freebuff thread.',{threadId:z.string(),text:z.string().min(1).max(100000)},(a)=>runtime.sendMessage(a.threadId,a.text));
  write('stop_thread','Stop a running Freebuff turn.',{threadId:z.string()},(a)=>runtime.stop(a.threadId));
  write('resume_thread','Resume a paused Freebuff thread.',{threadId:z.string()},(a)=>runtime.resume(a.threadId));
  write('set_model','Set the model for an existing thread when supported.',{threadId:z.string(),model:z.string().min(1),harnessId:z.string().optional()},(a)=>runtime.setModel(a.threadId,a.model,a.harnessId));
  write('set_reasoning','Set the reasoning effort for an existing thread when supported.',{threadId:z.string(),effort:z.string().nullable()},(a)=>runtime.setReasoning(a.threadId,a.effort));
  return s; }
export async function runStdio(){const runtime=await detectRuntime();const server=createServer(runtime,!(await runtime.capabilities()).readOnly);const cleanup=()=>runtime.dispose?.();process.once('SIGINT',cleanup);process.once('SIGTERM',cleanup);process.once('exit',cleanup);await server.connect(new StdioServerTransport());}
function isLoopback(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1'; }
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.FREEBUFF_MCP_TOKEN;
  if (!expected) return false;
  const supplied = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { const parsed = new URL(origin); return isLoopback(parsed.hostname); } catch { return false; }
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 2_000_000) throw new Error('Request too large'); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}
export async function runHttp(): Promise<void> {
  const runtime = await detectRuntime();
  const host = process.env.FREEBUFF_MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.FREEBUFF_MCP_PORT ?? 8788);
  if (!isLoopback(host) && process.env.FREEBUFF_MCP_ALLOW_REMOTE !== '1') throw new Error('Refusing non-loopback HTTP host; set FREEBUFF_MCP_ALLOW_REMOTE=1 only behind trusted HTTPS and authentication.');
  const recent = new Map<string, { at: number; count: number }>();
  const server = createHttpServer(async (req, res) => {
    if (!validOrigin(req)) { res.writeHead(403, {'content-type':'application/json'}); res.end(JSON.stringify({error:'invalid_origin'})); return; }
    const address = req.socket.remoteAddress ?? 'unknown'; const now = Date.now(); const bucket = recent.get(address); if (!bucket || now - bucket.at >= 60_000) recent.set(address, {at:now,count:1}); else { bucket.count++; if (bucket.count > 120) { res.writeHead(429, {'content-type':'application/json','retry-after':'60'}); res.end(JSON.stringify({error:'rate_limited'})); return; } }
    if (req.url === '/healthz' && req.method === 'GET') { if (!isLoopback(host) && !authorized(req)) { res.writeHead(401, {'www-authenticate':'Bearer'}); res.end(JSON.stringify({error:'unauthorized'})); return; } res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true,readOnly:(await runtime.capabilities()).readOnly})); return; }
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404, {'content-type':'application/json'}); res.end(JSON.stringify({error:'not_found'})); return; }
    if (!authorized(req)) { res.writeHead(401, {'www-authenticate':'Bearer'}); res.end(JSON.stringify({error:'unauthorized'})); return; }
    try {
      const mcp = createServer(runtime, !(await runtime.capabilities()).readOnly);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, await body(req));
      res.on('close', () => { void transport.close(); void mcp.close(); });
    } catch (error) {
      if (!res.headersSent) { res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error: error instanceof Error ? error.message : 'invalid_request'})); }
    }
  });
  const cleanup=()=>runtime.dispose?.(); server.once('close',cleanup); process.once('SIGINT',()=>{cleanup();server.close()}); process.once('SIGTERM',()=>{cleanup();server.close()}); process.once('exit',cleanup);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
  console.error(`freebuff-mcp HTTP listening on http://${host}:${port}/mcp`);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { detectRuntime, Runtime } from './runtime.js';
import { createDefaultAdapter, createV2ServerFromAdapter } from './mcp-v2.js';
import { VERSION } from './version.js';

function writeNames(caps: Awaited<ReturnType<Runtime['capabilities']>>): Set<string> { const map={sendMessage:'send_message',stop:'stop_thread',resume:'resume_thread',setModel:'set_model',setReasoning:'set_reasoning'}; return new Set(Object.entries(caps.actions??{sendMessage:!caps.readOnly,stop:!caps.readOnly,resume:!caps.readOnly,setModel:!caps.readOnly,setReasoning:!caps.readOnly}).filter(([,v])=>v).map(([k])=>map[k as keyof typeof map])); }

export function createServer(runtime: Runtime, includeWrites = true, allowedWrites = new Set(['send_message','stop_thread','resume_thread','set_model','set_reasoning'])): McpServer { const s=new McpServer({name:'freebuff-mcp',version:VERSION});
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
  if (allowedWrites.has('send_message')) write('send_message','Send a text prompt to an existing Freebuff thread.',{threadId:z.string(),text:z.string().min(1).max(100000)},(a)=>runtime.sendMessage(a.threadId,a.text));
  if (allowedWrites.has('stop_thread')) write('stop_thread','Stop a running Freebuff turn.',{threadId:z.string()},(a)=>runtime.stop(a.threadId));
  if (allowedWrites.has('resume_thread')) write('resume_thread','Resume a paused Freebuff thread.',{threadId:z.string()},(a)=>runtime.resume(a.threadId));
  if (allowedWrites.has('set_model')) write('set_model','Set the model for an existing thread when supported.',{threadId:z.string(),model:z.string().min(1),harnessId:z.string().optional()},(a)=>runtime.setModel(a.threadId,a.model,a.harnessId));
  if (allowedWrites.has('set_reasoning')) write('set_reasoning','Set the reasoning effort for an existing thread when supported.',{threadId:z.string(),effort:z.string().nullable()},(a)=>runtime.setReasoning(a.threadId,a.effort));
  return s; }
export async function runStdio(){const runtime=await detectRuntime();const caps=await runtime.capabilities();const server=createServer(runtime,!caps.readOnly,writeNames(caps));const cleanup=()=>runtime.dispose?.();process.once('SIGINT',cleanup);process.once('SIGTERM',cleanup);process.once('exit',cleanup);await server.connect(new StdioServerTransport());}
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
const MAX_BODY_BYTES = 2_000_000;
/** Bounded raw body text; the MCP handler owns parsing (and its 400s). */
async function rawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Track the running size instead of re-concatenating every chunk (which is
  // quadratic for a body split across many chunks).
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function runHttp(): Promise<void> {
  // HTTP serves the SAME canonical v2 surface as stdio (CompositeBackend +
  // SessionManager + TurnManager) through the modern per-request handler
  // (`createMcpHandler`), which negotiates every era the SDK supports —
  // including 2026-07-28 requests, which it answers with the server's best
  // supported revision. Only POST /mcp is served (a deliberate, tested
  // retention: no standalone GET SSE stream), and the 2025-era fallback stays
  // on intentionally for deployed clients.
  const adapter = createDefaultAdapter();
  const mcpHandler = createMcpHandler(() => createV2ServerFromAdapter(adapter), { legacy: 'stateless' });
  const host = process.env.FREEBUFF_MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.FREEBUFF_MCP_PORT ?? 8788);
  if (!isLoopback(host) && process.env.FREEBUFF_MCP_ALLOW_REMOTE !== '1') throw new Error('Refusing non-loopback HTTP host; set FREEBUFF_MCP_ALLOW_REMOTE=1 only behind trusted HTTPS and authentication.');
  const recent = new Map<string, { at: number; count: number }>();
  const RATE_WINDOW_MS = 60_000;
  const RATE_LIMIT = 120;
  /**
   * Bound the limiter's own memory: without pruning, one bucket per source
   * address accumulates for the lifetime of the process.
   */
  const pruneRecent = (now: number): void => {
    if (recent.size <= 1_024) return;
    for (const [key, bucket] of recent) if (now - bucket.at >= RATE_WINDOW_MS) recent.delete(key);
  };
  const server = createHttpServer(async (req, res) => {
    if (!validOrigin(req)) { res.writeHead(403, {'content-type':'application/json'}); res.end(JSON.stringify({error:'invalid_origin'})); return; }
    const address = req.socket.remoteAddress ?? 'unknown'; const now = Date.now(); pruneRecent(now); const bucket = recent.get(address); if (!bucket || now - bucket.at >= RATE_WINDOW_MS) recent.set(address, {at:now,count:1}); else { bucket.count++; if (bucket.count > RATE_LIMIT) { res.writeHead(429, {'content-type':'application/json','retry-after':'60'}); res.end(JSON.stringify({error:'rate_limited'})); return; } }
    if (req.url === '/healthz' && req.method === 'GET') { if (!isLoopback(host) && !authorized(req)) { res.writeHead(401, {'www-authenticate':'Bearer'}); res.end(JSON.stringify({error:'unauthorized'})); return; } res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true,readOnly:!(await adapter.backend.probe().catch(() => null))?.canSendMessage})); return; }
    if (req.url !== '/mcp') { res.writeHead(404, {'content-type':'application/json'}); res.end(JSON.stringify({error:'not_found'})); return; }
    if (!authorized(req)) { res.writeHead(401, {'www-authenticate':'Bearer'}); res.end(JSON.stringify({error:'unauthorized'})); return; }
    // The modern 2026-07-28 protocol uses GET to establish an SSE stream
    // and POST to send messages; createMcpHandler handles both.
    if (req.method === 'GET') {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) { for (const item of value) headers.append(key, item); } else headers.append(key, value);
        }
        const response = await mcpHandler.fetch(new Request(`http://127.0.0.1:${port}/mcp`, { method: 'GET', headers }));
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => { responseHeaders[key] = value; });
        res.writeHead(response.status, responseHeaders);
        if (response.body) {
          for await (const chunk of response.body) {
            if (!res.write(chunk)) await new Promise<void>((resolve) => res.once('drain', resolve));
          }
        }
        res.end();
      } catch {
        if (!res.headersSent) res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error:'invalid_request'}));
      }
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, {'content-type':'application/json'}); res.end(JSON.stringify({error:'method_not_allowed'})); return; }
    let raw: string;
    try {
      raw = await rawBody(req);
    } catch {
      if (!res.headersSent) { res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error:'Request too large'})); }
      return;
    }
    // Malformed JSON is rejected here with a plain 400 regardless of Accept
    // headers, so the contract never depends on handler content negotiation.
    if (raw.trim()) {
      try { JSON.parse(raw); } catch {
        res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error:'malformed JSON body'})); return;
      }
    }
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) { for (const item of value) headers.append(key, item); } else headers.append(key, value);
      }
      const response = await mcpHandler.fetch(new Request(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: raw }));
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });
      res.writeHead(response.status, responseHeaders);
      if (response.body) {
        for await (const chunk of response.body) {
          if (!res.write(chunk)) await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (error) {
      if (!res.headersSent) { res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error: error instanceof Error ? error.message : 'invalid_request'})); }
      else { try { res.end(); } catch { /* already closing */ } }
    }
  });
  const cleanup=()=>{ adapter.dispose(); void mcpHandler.close().catch(() => undefined); }; server.once('close',cleanup); process.once('SIGINT',()=>{cleanup();server.close()}); process.once('SIGTERM',()=>{cleanup();server.close()}); process.once('exit',cleanup);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
  console.error(`freebuff-mcp HTTP listening on http://${host}:${port}/mcp`);
}

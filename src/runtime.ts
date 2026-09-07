import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Capabilities, ProjectSummary, ThreadDetail, ThreadSummary, Json } from './types.js';
import { assertSafeId, blocked, redact, safeProjectPath, sanitizeFreebuff } from './security.js';
import { CliPtyManager, findFreebuffCli, findLatestCliConversationId } from './pty.js';

export interface Runtime {
  dispose?(): void;
  capabilities(): Promise<Capabilities>;
  listProjects(): Promise<ProjectSummary[]>;
  listThreads(projectId?: string): Promise<ThreadSummary[]>;
  getThread(id: string): Promise<ThreadDetail>;
  getMessages(id: string): Promise<Json>;
  activeWork(id?: string): Promise<Json>;
  listFiles(projectId: string, relative?: string): Promise<string[]>;
  readFile(projectId: string, relative: string): Promise<{ path: string; content: string }>;
  sendMessage(id: string, text: string): Promise<Json>;
  stop(id: string): Promise<Json>;
  resume(id: string): Promise<Json>;
  listModels(): Promise<Json>;
  setModel(id: string, model: string, harnessId?: string): Promise<Json>;
  setReasoning(id: string, effort: string | null): Promise<Json>;
}

async function readJson(file: string): Promise<Json | undefined> { try { return JSON.parse(await fs.readFile(file, 'utf8')) as Json; } catch { return undefined; } }
const execFileAsync = promisify(execFile);
function envRoot(): string { return process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd(); }
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function asString(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function cliProjectKey(root: string): string { return process.env.FREEBUFF_PROJECT_KEY ?? `${path.basename(root)}--${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12)}`; }
function cliChatsRoots(root: string): string[] { const base = path.join(os.homedir(), '.config', 'manicode', 'projects'); return [path.join(base, cliProjectKey(root), 'chats'), path.join(base, path.basename(root), 'chats')]; }
async function readLocalJson(file: string): Promise<any | undefined> { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return undefined; } }
async function cliHistory(root: string): Promise<Array<{ id: string; meta: any; messages: Json[]; state: any }>> {
  const out: Array<{ id: string; meta: any; messages: Json[]; state: any }> = [];
  for (const chats of cliChatsRoots(root)) try {
    for (const entry of await fs.readdir(chats, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9._:-]{1,200}$/.test(entry.name)) continue;
      const dir = path.join(chats, entry.name); const meta = await readLocalJson(path.join(dir, 'chat-meta.json')); const messages = await readLocalJson(path.join(dir, 'chat-messages.json')); const state = await readLocalJson(path.join(dir, 'run-state.json'));
      if (meta && Array.isArray(messages)) out.push({ id: entry.name, meta, messages: sanitizeFreebuff(messages) as Json[], state: sanitizeFreebuff(state ?? {}) });
    }
  } catch { /* CLI history may not exist yet */ }
  
  return out.sort((a, b) => a.id < b.id ? 1 : -1);
}
function candidates(): string[] { const home = os.homedir(); return [path.join(home, '.config', 'manicode', 'credentials.json'), path.join(home, 'AppData', 'Roaming', 'manicode', 'credentials.json')]; }
function desktopLogCandidates(): string[] {
  const home = os.homedir();
  return [
    path.join(process.env.APPDATA ?? '', 'Freebuff', 'logs', 'orchestrator-stderr.log'),
    path.join(home, 'AppData', 'Roaming', 'Freebuff', 'logs', 'orchestrator-stderr.log'),
    path.join(home, 'Library', 'Application Support', 'Freebuff', 'logs', 'orchestrator-stderr.log'),
    path.join(home, 'Library', 'Logs', 'Freebuff', 'orchestrator-stderr.log'),
    path.join(home, '.config', 'Freebuff', 'logs', 'orchestrator-stderr.log'),
    path.join(home, '.local', 'share', 'Freebuff', 'logs', 'orchestrator-stderr.log'),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}
async function discoverDesktopUrls(): Promise<string[]> {
  if (process.env.FREEBUFF_ORCHESTRATOR_URL) return [process.env.FREEBUFF_ORCHESTRATOR_URL];
  const urls = new Set<string>();
  for (const log of desktopLogCandidates()) {
    try {
      const text = await fs.readFile(log, 'utf8');
      for (const match of text.matchAll(/(?:https?:\/\/)?127\.0\.0\.1:(\d+)/g)) urls.add(`http://127.0.0.1:${match[1]}`);
    } catch { /* try the next platform-specific location */ }
  }
  try {
    const ports = process.platform === 'win32'
      ? (await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 | Select-Object -ExpandProperty LocalPort"], { timeout: 2000 })).stdout
      : (await execFileAsync('sh', ['-c', "command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP -sTCP:LISTEN -a -4 -F n | sed -n 's/^n.*:\\([0-9][0-9]*\\)$/\\1/p'"], { timeout: 2000 })).stdout;
    for (const port of ports.match(/\b[0-9]{2,5}\b/g) ?? []) { const n = Number(port); if (n > 0 && n < 65536) urls.add(`http://127.0.0.1:${n}`); }
  } catch { /* process/IPC fallback is best-effort on systems without the native listener utility */ }
  return [...urls].reverse();
}
async function discoverDesktopUrl(): Promise<string | null> {
  for (const url of await discoverDesktopUrls()) {
    try { const response = await fetch(new URL('/api/projects', url), { signal: AbortSignal.timeout(1500), headers: { accept: 'application/json' } }); if (response.ok) return url; } catch { /* try the next discovered endpoint */ }
  }
  return null;
}

export class DesktopOrchestratorRuntime implements Runtime {
  private base: URL; private explicitBase?: string; private caps?: Capabilities;
  constructor(base?: string) { this.explicitBase = base; this.base = new URL(base ?? 'http://127.0.0.1'); }
  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const c = new AbortController(); const timer = setTimeout(() => c.abort(), 5000);
    try { const r = await fetch(new URL(pathname, this.base), { method, signal: c.signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); if (!r.ok) throw new Error(`Freebuff returned HTTP ${r.status}`); return await r.json() as T; } finally { clearTimeout(timer); }
  }
  async capabilities(): Promise<Capabilities> { if (this.caps) return this.caps; const base = this.explicitBase ?? await discoverDesktopUrl(); if (!base) { this.caps = { product:'unknown', signedIn:'unknown', orchestrator:false, readOnly:true, endpoints:[], notes:['No Freebuff Desktop orchestrator was discovered. Checked process listeners, platform logs, and FREEBUFF_ORCHESTRATOR_URL.'] }; return this.caps; } this.base = new URL(base); try { const projects = await this.request<unknown>('GET','/api/projects'); const record=asRecord(projects); if (!record || !Array.isArray(record.projects)) throw new Error('invalid /api/projects response'); this.caps = { product:'desktop', signedIn:'unknown', orchestrator:true, readOnly:true, endpoints:['/api/projects','/api/thread/:id','/api/thread/:id/attachment'], notes:[`Live Desktop API responded at ${base} with ${record.projects.length} project roots. Desktop writes remain disabled because no verified Freebuff launch authorization contract is available.`] }; } catch (error) { this.caps = { product:'unknown', signedIn:'unknown', orchestrator:false, readOnly:true, endpoints:[], notes:[`Desktop discovery reached ${base}, but its response was invalid or unavailable: ${error instanceof Error ? error.message : 'unknown error'}`] }; } return this.caps; }
  async listProjects(): Promise<ProjectSummary[]> { const record=asRecord(await this.request<unknown>('GET','/api/projects')); if (!record || !Array.isArray(record.projects)) throw new Error('Invalid Freebuff /api/projects response'); return record.projects.flatMap((value) => { const p=asRecord(value); const projectPath=asString(p?.path); return projectPath ? [{ id:projectPath, path:projectPath, name:path.basename(projectPath), metadata:redact(p as Record<string, Json>) as Json }] : []; }); }
  async listThreads(projectId?: string): Promise<ThreadSummary[]> { const projects = await this.listProjects(); return projects.filter(p=>!projectId||p.id===projectId||p.path===projectId).flatMap(p=>{const raw=asRecord(p.metadata); const threads=Array.isArray(raw?.threads)?raw.threads:[]; return threads.flatMap((value)=>{const t=asRecord(value); const id=asString(t?.id); if(!id)return []; return [{id,projectId:p.id,title:asString(t?.title),state:asString(t?.turnState),model:asString(t?.model),metadata:redact(t as Record<string, Json>) as Json}];});}); }
  async getThread(id:string):Promise<ThreadDetail>{const value=asRecord(await this.request('GET',`/api/thread/${encodeURIComponent(assertSafeId(id))}`));if(!value)throw new Error('Invalid Freebuff thread response');const threadId=asString(value.id)??assertSafeId(id);return {id:threadId,projectId:asString(value.projectId),title:asString(value.title),state:asString(value.turnState),model:asString(value.model),messages:Array.isArray(value.messages)?sanitizeFreebuff(value.messages) as Json[]:undefined,activeWork:value.activeWork===undefined?undefined:sanitizeFreebuff(value.activeWork) as Json,metadata:redact(value as Record<string, Json>) as Json};}
  async getMessages(id:string):Promise<Json>{const t=await this.getThread(id); return sanitizeFreebuff(t.messages ?? []) as Json;}
  async activeWork(id?:string):Promise<Json>{const threads=await this.listThreads();return threads.filter(t=>(!id||t.id===id)&&t.state&&t.state!=='idle') as unknown as Json;}
  async listFiles(projectId:string, relative='.') { const p=(await this.listProjects()).find(x=>x.id===projectId||x.path===projectId); if(!p) throw new Error('Project not found'); const root=await fs.realpath(p.path); const dir=relative==='.'?root:await fs.realpath(path.resolve(root,relative)); const rel=path.relative(root,dir); if(rel.startsWith('..')||path.isAbsolute(rel)||rel.split(path.sep).some(part=>blocked.test(part))) throw new Error('Path escapes the Freebuff project'); const entries=await fs.readdir(dir,{withFileTypes:true}); return entries.filter(e=>e.isFile()&&!blocked.test(e.name)).map(e=>path.relative(root,path.join(dir,e.name))); }
  async readFile(projectId:string, relative:string){const p=(await this.listProjects()).find(x=>x.id===projectId||x.path===projectId);if(!p)throw new Error('Project not found');const file=await safeProjectPath(p.path,relative);return {path:relative,content:await fs.readFile(file,'utf8')};}
  private async assertWritable(): Promise<void> { if ((await this.capabilities()).readOnly) throw new Error('Freebuff Desktop writes are unavailable: no verified launch authorization contract'); }
  async sendMessage(id:string,text:string){await this.assertWritable();if(!text||text.length>100000)throw new Error('Message must be 1 to 100000 characters');return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/message`,{text})) as Json;}
  async stop(id:string){await this.assertWritable();return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/stop`,{})) as Json;}
  async resume(id:string){await this.assertWritable();return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/resume`,{})) as Json;}
  async listModels(){return {note:'The installed Desktop does not expose a standalone model-catalog route. Use the current thread model and set_model validation.'};}
  async setModel(id:string,model:string,harnessId='codebuff'){await this.assertWritable();if(model.length>200)throw new Error('Invalid model');return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/agent`,{model,harnessId})) as Json;}
  async setReasoning(id:string,effort:string){await this.assertWritable();return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/effort`,{effort})) as Json;}
}

export class ReadOnlyRuntime extends DesktopOrchestratorRuntime {
  override async capabilities(): Promise<Capabilities> {
    const caps = await super.capabilities();
    return { ...caps, readOnly: true, notes: [...caps.notes, 'This MCP process is operating in read-only mode.'] };
  }
  override async sendMessage(_id: string, _text: string): Promise<Json>{throw new Error('Freebuff is unavailable or read-only');}
  override async stop(_id: string): Promise<Json>{throw new Error('Freebuff is unavailable or read-only');}
  override async resume(_id: string): Promise<Json>{throw new Error('Freebuff is unavailable or read-only');}
  override async setModel(_id: string, _model: string, _harnessId?: string): Promise<Json>{throw new Error('Freebuff is unavailable or read-only');}
  override async setReasoning(_id: string, _effort: string | null): Promise<Json>{throw new Error('Freebuff is unavailable or read-only');}
}
export class CliPtyRuntime implements Runtime {
  private manager = new CliPtyManager();
  private root = envRoot();
  async capabilities(): Promise<Capabilities> { const cli = await findFreebuffCli(); return { product:'cli', signedIn:'unknown', orchestrator:false, readOnly:!cli, endpoints:['managed PTY'], notes:[cli ? `Official Freebuff CLI detected at ${path.basename(cli)}. PTY control is enabled for bridge-owned sessions.` : 'Official Freebuff CLI was not found.'] }; }
  async listProjects(): Promise<ProjectSummary[]> { return [{ id:this.root, path:this.root, name:path.basename(this.root) }]; }
  async listThreads(): Promise<ThreadSummary[]> { return (await cliHistory(this.root)).map((c) => ({ id:c.id, projectId:this.root, title:typeof c.meta.firstPrompt==='string'?c.meta.firstPrompt:'Managed Freebuff CLI session', state:typeof c.state?.sessionState?.mainAgentState==='object'?'completed':undefined, metadata:{messageCount:c.meta.messageCount, conversationId:c.id} })); }
  async getThread(id:string): Promise<ThreadDetail> { const safe=assertSafeId(id); const c=(await cliHistory(this.root)).find((x)=>x.id===safe); if(c) return { id:safe, projectId:this.root, title:typeof c.meta.firstPrompt==='string'?c.meta.firstPrompt:'Managed Freebuff CLI session', messages:c.messages, metadata:{messageCount:c.meta.messageCount, conversationId:safe} }; return { id:safe, projectId:this.root, title:'Managed Freebuff CLI session', metadata:redact(this.manager.snapshot(safe)) as Json }; }
  async getMessages(id:string): Promise<Json> { const c=(await cliHistory(this.root)).find((x)=>x.id===assertSafeId(id)); return c ? c.messages : redact(this.manager.snapshot(id)) as Json; }
  async activeWork(id?:string): Promise<Json> { return id ? redact(this.manager.snapshot(id)) as Json : []; }
  async listFiles(_projectId:string, relative='.') { const root=await fs.realpath(this.root); const dir=relative==='.'?root:await fs.realpath(path.resolve(root,relative)); const rel=path.relative(root,dir); if(rel.startsWith('..')||path.isAbsolute(rel)||rel.split(path.sep).some(part=>blocked.test(part))) throw new Error('Path escapes the Freebuff project'); const entries=await fs.readdir(dir,{withFileTypes:true}); return entries.filter(e=>e.isFile()&&!blocked.test(e.name)).map(e=>path.relative(root,path.join(dir,e.name))); }
  async readFile(_projectId:string, relative:string): Promise<{path:string;content:string}> { const file=await safeProjectPath(this.root,relative); return {path:relative,content:await fs.readFile(file,'utf8')}; }
  async sendMessage(id:string,text:string): Promise<Json> { return redact(await this.manager.send(id,text,this.root)) as Json; }
  async stop(id:string): Promise<Json> { return redact(this.manager.stop(id)) as Json; }
  async resume(id:string): Promise<Json> { return redact(await this.manager.resumeLatest(id,this.root)) as Json; }
  async listModels(): Promise<Json> { return { note:'Use the Freebuff CLI /model picker inside a managed PTY session.' }; }
  async setModel(id:string,model:string): Promise<Json> { return redact(await this.manager.sendToLatest(id,`/model ${model}`,this.root)) as Json; }
  async setReasoning(id:string,effort:string|null): Promise<Json> { return redact(await this.manager.sendToLatest(id,`/reasoning ${effort ?? ''}`,this.root)) as Json; }
  dispose(): void { this.manager.dispose(); }
}
export async function detectRuntime(): Promise<Runtime> {
  if (process.env.FREEBUFF_MCP_CLI_MODE === 'pty') return await findFreebuffCli() ? new CliPtyRuntime() : new ReadOnlyRuntime();
  const desktop = new DesktopOrchestratorRuntime();
  if ((await desktop.capabilities()).orchestrator) return desktop;
  if (await findFreebuffCli()) return new CliPtyRuntime();
  return new ReadOnlyRuntime();
}
export async function localInstallInfo(): Promise<Json> { const found: Array<{path:string;signedIn:boolean}> = []; for(const c of candidates()){const j=await readJson(c); const o=j&&typeof j==='object'&&!Array.isArray(j)?j as Record<string,Json>:undefined; const d=o?.default&&typeof o.default==='object'&&!Array.isArray(o.default)?o.default as Record<string,Json>:undefined; if(o) found.push({path:c,signedIn:Boolean(d?.authToken||o.authToken)});} return {cli: Boolean(await findFreebuffCli()),credentials:found}; }


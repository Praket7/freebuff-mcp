import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Capabilities, ProjectSummary, ThreadDetail, ThreadSummary, Json } from './types.js';
import { assertSafeId, blocked, redact, safeProjectPath, sanitizeFreebuff } from './security.js';

export interface Runtime {
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
function envRoot(): string { return process.env.FREEBUFF_PROJECT_ROOT ?? process.cwd(); }
function candidates(): string[] { const home = os.homedir(); return [path.join(home, '.config', 'manicode', 'credentials.json'), path.join(home, 'AppData', 'Roaming', 'manicode', 'credentials.json')]; }
async function discoverDesktopUrl(): Promise<string> {
  if (process.env.FREEBUFF_ORCHESTRATOR_URL) return process.env.FREEBUFF_ORCHESTRATOR_URL;
  const log = path.join(process.env.APPDATA ?? '', 'Freebuff', 'logs', 'orchestrator-stderr.log');
  try { const text = await fs.readFile(log, 'utf8'); const matches = [...text.matchAll(/127\.0\.0\.1:(\d+)/g)]; const port = matches.at(-1)?.[1]; if (port) return `http://127.0.0.1:${port}`; } catch { /* app may not be installed */ }
  return 'http://127.0.0.1:49152';
}

export class DesktopOrchestratorRuntime implements Runtime {
  private base: URL; private caps?: Capabilities;
  constructor(base?: string) { this.base = new URL(base ?? 'http://127.0.0.1:49152'); }
  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const c = new AbortController(); const timer = setTimeout(() => c.abort(), 5000);
    try { const r = await fetch(new URL(pathname, this.base), { method, signal: c.signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); if (!r.ok) throw new Error(`Freebuff returned HTTP ${r.status}`); return await r.json() as T; } finally { clearTimeout(timer); }
  }
  async capabilities(): Promise<Capabilities> { if (this.caps) return this.caps; try { const base = await discoverDesktopUrl(); this.base = new URL(base); const projects = await this.request<{projects?: unknown[]}>('GET','/api/projects'); const endpoints = ['/api/projects','/api/thread/:id','/api/thread/:id/attachment']; const authorized = Boolean(process.env.FREEBUFF_LAUNCH_ID); this.caps = { product:'desktop', signedIn:'unknown', orchestrator:true, readOnly:!authorized, endpoints, notes:[`Live Desktop API responded with ${projects.projects?.length ?? 0} recent project roots. ${authorized ? 'Authorized mutations are enabled.' : 'Desktop mutations are disabled because the standalone bridge has no authorized launch capability.'}`] }; } catch { this.caps = { product:'unknown', signedIn:'unknown', orchestrator:false, readOnly:true, endpoints:[], notes:['No Freebuff Desktop orchestrator responded on the discovered localhost URL.'] }; } return this.caps; }
  async listProjects(): Promise<ProjectSummary[]> { const x = await this.request<{projects?: Array<Record<string, Json>>}>('GET','/api/projects'); return (x.projects ?? []).map((p) => ({ id: String(p.path), path: String(p.path ?? ''), name: path.basename(String(p.path ?? '')), metadata: redact(p) as Json })); }
  async listThreads(projectId?: string): Promise<ThreadSummary[]> { const projects = await this.listProjects(); return projects.filter(p=>!projectId||p.id===projectId||p.path===projectId).flatMap(p=>{const raw=p.metadata&&typeof p.metadata==='object'&&!Array.isArray(p.metadata)?(p.metadata as Record<string,Json>):{}; const threads=Array.isArray(raw.threads)?raw.threads:[]; return threads.filter((t):t is Record<string,Json>=>!!t&&typeof t==='object'&&!Array.isArray(t)).map(t=>({id:String(t.id),projectId:p.id,title:typeof t.title==='string'?t.title:undefined,state:typeof t.turnState==='string'?t.turnState:undefined,model:typeof t.model==='string'?t.model:undefined,metadata:redact(t) as Json}));}); }
  async getThread(id:string):Promise<ThreadDetail>{return sanitizeFreebuff(await this.request('GET',`/api/thread/${encodeURIComponent(assertSafeId(id))}`)) as ThreadDetail;}
  async getMessages(id:string):Promise<Json>{const t=await this.getThread(id); return sanitizeFreebuff(t.messages ?? []) as Json;}
  async activeWork(id?:string):Promise<Json>{const threads=await this.listThreads();return threads.filter(t=>(!id||t.id===id)&&t.state&&t.state!=='idle') as unknown as Json;}
  async listFiles(projectId:string, relative='.') { const p=(await this.listProjects()).find(x=>x.id===projectId||x.path===projectId); if(!p) throw new Error('Project not found'); const root=await fs.realpath(p.path); const dir=relative==='.'?root:await safeProjectPath(root,relative); const entries=await fs.readdir(dir,{withFileTypes:true}); return entries.filter(e=>!blocked.test(e.name)).map(e=>path.relative(root,path.join(dir,e.name))); }
  async readFile(projectId:string, relative:string){const p=(await this.listProjects()).find(x=>x.id===projectId||x.path===projectId);if(!p)throw new Error('Project not found');const file=await safeProjectPath(p.path,relative);return {path:relative,content:await fs.readFile(file,'utf8')};}
  async sendMessage(id:string,text:string){if(!text||text.length>100000)throw new Error('Message must be 1 to 100000 characters');return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/message`,{text})) as Json;}
  async stop(id:string){return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/stop`,{})) as Json;}
  async resume(id:string){return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/resume`,{})) as Json;}
  async listModels(){return {note:'The installed Desktop does not expose a standalone model-catalog route. Use the current thread model and set_model validation.'};}
  async setModel(id:string,model:string,harnessId='codebuff'){if(model.length>200)throw new Error('Invalid model');return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/agent`,{model,harnessId})) as Json;}
  async setReasoning(id:string,effort:string){return redact(await this.request('POST',`/api/thread/${encodeURIComponent(assertSafeId(id))}/effort`,{effort})) as Json;}
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
export async function detectRuntime(): Promise<Runtime> { const url=await discoverDesktopUrl(); const r=new DesktopOrchestratorRuntime(url); if((await r.capabilities()).orchestrator && process.env.FREEBUFF_LAUNCH_ID)return r; if((await r.capabilities()).orchestrator)return new ReadOnlyRuntime(url); return new ReadOnlyRuntime(url); }
export async function localInstallInfo(): Promise<Json> { const found: Array<{path:string;signedIn:boolean}> = []; for(const c of candidates()){const j=await readJson(c); const o=j&&typeof j==='object'&&!Array.isArray(j)?j as Record<string,Json>:undefined; const d=o?.default&&typeof o.default==='object'&&!Array.isArray(o.default)?o.default as Record<string,Json>:undefined; if(o) found.push({path:c,signedIn:Boolean(d?.authToken||o.authToken)});} return {cli: Boolean(await readJson(path.join(os.homedir(),'.config','manicode','freebuff'))),credentials:found}; }


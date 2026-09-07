import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { detectRuntime, Runtime } from './runtime.js';

export function createServer(runtime: Runtime): McpServer { const s=new McpServer({name:'freebuff-mcp',version:'0.1.0'});
  const read=(name:string,description:string,schema:Record<string,z.ZodType>,fn:(a:any)=>Promise<unknown>)=>s.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:true,openWorldHint:false}},async(a)=>({content:[{type:'text',text:JSON.stringify(await fn(a),null,2)}]}));
  read('freebuff_status','Detect Freebuff and bridge capabilities.',{},()=>runtime.capabilities());
  read('list_projects','List discovered Freebuff projects.',{},()=>runtime.listProjects());
  read('list_threads','List Freebuff Desktop threads.',{projectId:z.string().optional()},(a)=>runtime.listThreads(a.projectId));
  read('get_thread','Read thread metadata.',{threadId:z.string()},(a)=>runtime.getThread(a.threadId));
  read('get_thread_messages','Read visible messages for a thread.',{threadId:z.string()},(a)=>runtime.getMessages(a.threadId));
  read('get_active_work','Read visible active work.',{threadId:z.string().optional()},(a)=>runtime.activeWork(a.threadId));
  read('list_project_files','List safe project files.',{projectId:z.string(),relative:z.string().optional()},(a)=>runtime.listFiles(a.projectId,a.relative));
  read('read_project_file','Read one safe project file.',{projectId:z.string(),path:z.string()},(a)=>runtime.readFile(a.projectId,a.path));
  read('list_models','List models exposed by the installed bridge.',{},()=>runtime.listModels());
  const write=(name:string,description:string,schema:Record<string,z.ZodType>,fn:(a:any)=>Promise<unknown>)=>s.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},async(a)=>({content:[{type:'text',text:JSON.stringify(await fn(a),null,2)}]}));
  write('send_message','Send a text prompt to an existing Freebuff thread.',{threadId:z.string(),text:z.string().min(1).max(100000)},(a)=>runtime.sendMessage(a.threadId,a.text));
  write('stop_thread','Stop a running Freebuff turn.',{threadId:z.string()},(a)=>runtime.stop(a.threadId));
  write('resume_thread','Resume a paused Freebuff thread.',{threadId:z.string()},(a)=>runtime.resume(a.threadId));
  write('set_model','Set the model for an existing thread when supported.',{threadId:z.string(),model:z.string().min(1),harnessId:z.string().optional()},(a)=>runtime.setModel(a.threadId,a.model,a.harnessId));
  write('set_reasoning','Set the reasoning effort for an existing thread when supported.',{threadId:z.string(),effort:z.string().nullable()},(a)=>runtime.setReasoning(a.threadId,a.effort));
  return s; }
export async function runStdio(){const server=createServer(await detectRuntime());await server.connect(new StdioServerTransport());}


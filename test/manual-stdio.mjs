// Manual real-client check: speaks MCP stdio to the built server binary.
import { spawn } from 'node:child_process';

const serverPath = process.env.FREEBUFF_MCP_BINARY ?? new URL('../dist/src/cli.js', import.meta.url).pathname;
const child = spawn(process.execPath, [serverPath, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* not JSON */ }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'manual-check', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await rpc('tools/list', {});
const toolDefinitions = tools.result.tools;
const names = toolDefinitions.map((t) => t.name);
console.log('tools:', names.length);
const requiredTools = ['get_model_catalog_status', 'search_threads', 'search_threads_page', 'search_thread_messages', 'get_thread_messages_page', 'list_threads_page'];
if (names.length !== 38) { console.error(`Expected 38 MCP v2 tools, received ${names.length}`); process.exit(1); }
for (const name of requiredTools) {
  if (!names.includes(name)) { console.error(`Missing MCP v2 tool ${name}`); process.exit(1); }
}
for (const [name, variants] of [['send_message', 3], ['run_turn', 3], ['stop_thread', 2]]) {
  const schema = toolDefinitions.find((tool) => tool.name === name)?.inputSchema;
  if (!Array.isArray(schema?.anyOf) || schema.anyOf.length !== variants) {
    console.error(`${name} does not publish its identity constraints as a JSON Schema union`); process.exit(1);
  }
}
for (const tool of toolDefinitions) {
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    if (typeof tool.annotations?.[hint] !== 'boolean') { console.error(`${tool.name} is missing boolean ${hint}`); process.exit(1); }
  }
  if (typeof tool.description !== 'string' || tool.description.length < 30) { console.error(`${tool.name} is missing an actionable description`); process.exit(1); }
  const variants = tool.inputSchema?.anyOf ?? tool.inputSchema?.oneOf ?? [tool.inputSchema];
  for (const variant of variants) {
    for (const [field, schema] of Object.entries(variant?.properties ?? {})) {
      if (typeof schema.description !== 'string' || schema.description.length < 10) { console.error(`${tool.name}.${field} is missing a parameter description`); process.exit(1); }
    }
  }
}
for (const name of ['get_freebuff_status', 'freebuff_status', 'create_thread', 'start_thread', 'get_thread_settings', 'list_models', 'get_thread_messages_page', 'search_thread_messages', 'list_threads_page', 'search_threads_page']) {
  if (!toolDefinitions.find((tool) => tool.name === name)?.outputSchema) { console.error(`${name} is missing its declared output schema`); process.exit(1); }
}
console.log('all tools have descriptions and explicit behavior hints; stable outputs have schemas');
console.log('has run_turn:', names.includes('run_turn'), '| has start_thread:', names.includes('start_thread'), '| has get_turn:', names.includes('get_turn'));
for (const required of ['get_thread_progress_summary', 'get_diff', 'get_changed_files', 'get_freebuff_status', 'freebuff_status', 'get_project_file', 'read_project_file', 'get_thread_settings', 'create_thread', 'start_thread']) {
  if (!names.includes(required)) { console.error(`MISSING TOOL: ${required}`); process.exit(1); }
}
console.log('canonical names and compatibility aliases present');

for (const [name, arguments_] of [
  ['send_message', { sessionId: 'session-a', threadId: 'thread-b', text: 'invalid target' }],
  ['stop_thread', {}],
]) {
  const invalid = await rpc('tools/call', { name, arguments: arguments_ });
  if (invalid.result?.isError !== true) { console.error(`${name} did not reject invalid identity input at the schema boundary`); process.exit(1); }
}
console.log('invalid identity arguments rejected before handlers run');

const status = await rpc('tools/call', { name: 'get_freebuff_status', arguments: {} });
const statusData = JSON.parse(status.result.content[0].text);
const legacyStatus = await rpc('tools/call', { name: 'freebuff_status', arguments: {} });
if (JSON.stringify(JSON.parse(legacyStatus.result.content[0].text)) !== JSON.stringify(statusData)) {
  console.error('freebuff_status compatibility alias returned different data'); process.exit(1);
}
console.log('status:', statusData.connection, '/', statusData.authorization, '/ live:', statusData.liveProgress);

const threads = await rpc('tools/call', { name: 'list_projects', arguments: {} });
const projects = JSON.parse(threads.result.content[0].text);
console.log('projects discovered:', Array.isArray(projects.projects) ? projects.projects.length : 'n/a');

// The new read tools must answer structurally against a real server, never throw.
const summary = JSON.parse((await rpc('tools/call', { name: 'get_thread_progress_summary', arguments: { threadId: 'manual-check-thread' } })).result.content[0].text);
console.log('summary:', JSON.stringify({ ok: summary.ok, connected: summary.connected, stale: summary.stale, hasEvents: Object.prototype.hasOwnProperty.call(summary, 'events') }));
if (summary.ok !== true || Object.prototype.hasOwnProperty.call(summary, 'events')) { console.error('get_thread_progress_summary returned an unexpected shape'); process.exit(1); }

const diff = JSON.parse((await rpc('tools/call', { name: 'get_diff', arguments: { threadId: 'manual-check-thread' } })).result.content[0].text);
console.log('diff:', JSON.stringify({ ok: diff.ok, files: diff.files, diffAvailable: diff.diffAvailable }));
if (diff.ok !== true || !Array.isArray(diff.files)) { console.error('get_diff returned an unexpected shape'); process.exit(1); }

child.kill();
process.exit(0);

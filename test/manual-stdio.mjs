// Manual real-client check: speaks MCP stdio to the built server binary.
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, [new URL('../dist/src/cli.js', import.meta.url).pathname, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
const names = tools.result.tools.map((t) => t.name);
console.log('tools:', names.length);
console.log('has run_turn:', names.includes('run_turn'), '| has start_thread:', names.includes('start_thread'), '| has get_turn:', names.includes('get_turn'));
for (const required of ['get_thread_progress_summary', 'get_diff', 'get_changed_files', 'freebuff_status']) {
  if (!names.includes(required)) { console.error(`MISSING TOOL: ${required}`); process.exit(1); }
}
console.log('new parity tools present: get_thread_progress_summary, get_diff');

const status = await rpc('tools/call', { name: 'freebuff_status', arguments: {} });
const statusData = JSON.parse(status.result.content[0].text);
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

import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { detectRuntime, Runtime } from './runtime.js';

type Session = { runtime: Runtime; threadId: string; cwd: string; cancelled: boolean };
const text = (params: any): string => (params.prompt ?? []).filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('\n');

export async function runAcp(): Promise<void> {
  const runtime = await detectRuntime();
  const sessions = new Map<string, Session>();
  const app = agent({ name: 'freebuff-mcp' })
    .onRequest(methods.agent.initialize, async () => ({ protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'freebuff-mcp', version: '0.1.16' }, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: true }, sessionCapabilities: { close: {} } } }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const sessionId = randomUUID(); sessions.set(sessionId, { runtime, threadId: sessionId, cwd: params.cwd, cancelled: false });
      return { sessionId };
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => { const session = sessions.get(params.sessionId); if (session) session.cancelled = true; })
    .onRequest(methods.agent.session.close, async ({ params }) => { sessions.delete(params.sessionId); return {}; })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const session = sessions.get(params.sessionId); if (!session) throw new Error('ACP session not found');
      session.cancelled = false;
      try {
        const result = await session.runtime.sendMessage(session.threadId, text(params));
        if (session.cancelled) return { stopReason: 'cancelled' as const };
        const output = typeof result === 'string' ? result : JSON.stringify(result);
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } } });
        return { stopReason: 'end_turn' as const };
      } catch (error) {
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: error instanceof Error ? error.message : 'Freebuff request failed' } } });
        return { stopReason: 'refusal' as const };
      }
    });
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const connection = app.connect(stream);
  process.once('SIGINT', () => { runtime.dispose?.(); connection.close(); }); process.once('SIGTERM', () => { runtime.dispose?.(); connection.close(); });
}

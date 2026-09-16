import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { detectRuntime, Runtime } from './runtime.js';

const VERSION = '0.1.17';
type Session = { runtime: Runtime; threadId: string; cwd: string; cancelled: boolean; controller: AbortController };
const promptText = (params: any): string => (params.prompt ?? []).filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('\n');
const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return ['text', 'content', 'message', 'output', 'assistantText'].flatMap(key => strings(record[key]));
};
const assistantStrings = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(assistantStrings);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const role = String(record.role ?? record.variant ?? record.author ?? '').toLowerCase();
  if (role === 'assistant' || role === 'ai' || role === 'freebuff') return strings(record.content ?? record.text ?? record.message ?? record.output);
  return Object.values(record).flatMap(assistantStrings);
};
const emit = (client: any, sessionId: string, value: unknown) => client.notify(methods.client.session.update, { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } });

export async function runAcp(): Promise<void> {
  const runtime = await detectRuntime();
  const sessions = new Map<string, Session>();
  const app = agent({ name: 'freebuff-mcp' })
    .onRequest(methods.agent.initialize, async () => ({ protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'freebuff-mcp', version: VERSION }, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: true }, loadSession: false, sessionCapabilities: { close: {}, resume: {} } } }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      if (!runtime.createSession) throw new Error('ACP session creation is unavailable for the selected Freebuff runtime');
      const threadId = await runtime.createSession(params.cwd);
      const sessionId = randomUUID();
      sessions.set(sessionId, { runtime, threadId, cwd: params.cwd, cancelled: false, controller: new AbortController() });
      return { sessionId };
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session) return;
      session.cancelled = true;
      session.controller.abort();
      await session.runtime.stop(session.threadId).catch(() => undefined);
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (session) { session.cancelled = true; session.controller.abort(); await session.runtime.stop(session.threadId).catch(() => undefined); sessions.delete(params.sessionId); }
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      const session = sessions.get(params.sessionId);
      if (!session) throw new Error('ACP session not found');
      session.cancelled = false;
      session.controller = new AbortController();
      const sent = session.runtime.sendMessage(session.threadId, promptText(params));
      const seen = new Set<string>();
      const poll = async (): Promise<void> => {
        while (!session.controller.signal.aborted) {
          try {
            const snapshot = await session.runtime.getThreadProgress(session.threadId, 0, 100);
            for (const event of snapshot.events) for (const chunk of strings(event.text)) if (!seen.has(`${event.sequence}:${chunk}`)) { seen.add(`${event.sequence}:${chunk}`); await emit(client, params.sessionId, chunk); }
            const messages = await session.runtime.getMessages(session.threadId);
            for (const chunk of assistantStrings(messages)) if (!seen.has(`message:${chunk}`)) { seen.add(`message:${chunk}`); await emit(client, params.sessionId, chunk); }
          } catch { /* the provider may not expose live progress */ }
          if (session.controller.signal.aborted) return;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      };
      const polling = poll();
      try {
        const result = await sent;
        session.controller.abort();
        await polling;
        if (session.cancelled) return { stopReason: 'cancelled' as const };
        if (!seen.size) await emit(client, params.sessionId, 'Freebuff completed without assistant text.');
        return { stopReason: 'end_turn' as const };
      } catch (error) {
        session.controller.abort();
        await polling;
        if (session.cancelled) return { stopReason: 'cancelled' as const };
        await emit(client, params.sessionId, error instanceof Error ? error.message : 'Freebuff request failed');
        return { stopReason: 'refusal' as const };
      }
    });
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const connection = app.connect(stream);
  const cleanup = () => { for (const session of sessions.values()) { session.controller.abort(); void session.runtime.stop(session.threadId).catch(() => undefined); } runtime.dispose?.(); connection.close(); };
  process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup);
}

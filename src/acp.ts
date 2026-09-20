import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
// The ACP request context carries `params` and an `AgentContext` client. The
// client exposes notify(method, params); use CLIENT_METHODS.session_update.
import { CLIENT_METHODS } from '@agentclientprotocol/sdk';
type PromptContext = { params: { sessionId: string; prompt?: Array<{ type?: string; text?: string }> }; client: { notify: (method: string, params: unknown) => Promise<void> } };
type NewSessionContext = { params: { cwd: string } };
type SessionIdContext = { params: { sessionId: string } };
import { CompositeBackend } from './backends/backend.js';
import { SessionManager } from './bridge/session-manager.js';
import { TurnManager } from './bridge/turn-manager.js';
import { isTerminalTurnState } from './bridge/types.js';
import { VERSION } from './version.js';

interface AcpSession {
  bridgeSessionId: string;
  threadId: string;
  cwd: string;
  controller: AbortController;
}

/**
 * ACP adapter (experimental).
 *
 * Guarantees:
 * - ACP session ids map to canonical bridge sessions and REAL Freebuff thread
 *   identities; random ACP UUIDs are never passed to Freebuff as conversation
 *   ids.
 * - session/prompt does not return when submission returns; it waits for the
 *   canonical turn to reach a terminal state.
 * - Progress reads use an advancing cursor (never afterSequence=0 loops).
 * - Assistant text comes from structured assistant deltas/messages only; no
 *   fabricated text, no duplicated accumulation of cumulative snapshots.
 * - Only implemented capabilities are advertised (loadSession is NOT).
 * - Infrastructure failures are reported as errors, not model refusals.
 */
export async function runAcp(): Promise<void> {
  const backend = new CompositeBackend();
  const sessions = new SessionManager(backend);
  const turns = new TurnManager(sessions);
  const acpSessions = new Map<string, AcpSession>();

  const app = agent({ name: 'freebuff-mcp' })
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'freebuff-mcp', version: VERSION },
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        loadSession: false,
      },
    }))
    .onRequest(methods.agent.session.new, async ({ params }: NewSessionContext) => {
      // Create a real backend-backed session (Desktop thread or CLI
      // conversation). Bridge identity differs from backend identity.
      const session = await sessions.createSession({ cwd: params.cwd });
      const sessionId = randomUUID();
      acpSessions.set(sessionId, { bridgeSessionId: session.id, threadId: session.backendSessionId ?? session.id, cwd: params.cwd, controller: new AbortController() });
      return { sessionId };
    })
    .onNotification(methods.agent.session.cancel, async ({ params }: SessionIdContext) => {
      const session = acpSessions.get(params.sessionId);
      if (!session) return;
      session.controller.abort();
      await turns.cancelTurn(session.bridgeSessionId).catch(() => undefined);
    })
    .onRequest(methods.agent.session.close, async ({ params }: SessionIdContext) => {
      const session = acpSessions.get(params.sessionId);
      if (session) {
        session.controller.abort();
        await turns.cancelTurn(session.bridgeSessionId).catch(() => undefined);
        acpSessions.delete(params.sessionId);
      }
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }: PromptContext) => {
      const acpSession = acpSessions.get(params.sessionId);
      if (!acpSession) throw new Error('ACP session not found');
      acpSession.controller = new AbortController();
      const promptText = (params.prompt ?? []).filter((block: { type?: string }) => block?.type === 'text').map((block: { text?: string }) => block.text ?? '').join('\n');

      const session = sessions.getSession(acpSession.bridgeSessionId);
      if (!session) throw new Error('ACP session lost');
      const threadKey = session.backendSessionId ?? session.id;

      // Stream structured assistant deltas/messages from the shared event
      // store with an advancing cursor. Cumulative snapshots are not re-sent.
      let cursor = 0;
      const unsubscribe = sessions.events.subscribe((threadId) => {
        if (threadId !== threadKey) return;
        const page = sessions.events.read({ threadId: threadKey, afterSequence: cursor, limit: 100 });
        for (const event of page.events) {
          cursor = Math.max(cursor, event.sequence);
          if (event.type === 'assistant_delta' || event.type === 'assistant_message') {
            if (event.message) {
              void Promise.resolve(client.notify(CLIENT_METHODS.session_update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.message } } })).catch(() => undefined);
            }
          }
        }
      });

      const handle = sessions.startTurn(acpSession.bridgeSessionId, { text: promptText, signal: acpSession.controller.signal });
      sessions.registerController(handle.turn.id, acpSession.controller);
      try {
        const turn = await handle.done;
        // Drain any final events that arrived between the last subscription
        // callback and terminal state.
        const finalPage = sessions.events.read({ threadId: threadKey, afterSequence: cursor, limit: 100 });
        for (const event of finalPage.events) {
          if ((event.type === 'assistant_delta' || event.type === 'assistant_message') && event.message) {
            await client.notify(CLIENT_METHODS.session_update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.message } } }).catch(() => undefined);
          }
        }
        if (turn.state === 'cancelled') return { stopReason: 'cancelled' as const };
        if (turn.state === 'failed') {
          // Infrastructure/backend failure: surface the error text and use
          // end_turn with the error message instead of claiming a model refusal.
          const detail = turn.error ?? 'The Freebuff backend reported a failure.';
          await client.notify(CLIENT_METHODS.session_update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Freebuff backend error: ${detail}` } } }).catch(() => undefined);
          return { stopReason: 'end_turn' as const };
        }
        return { stopReason: 'end_turn' as const };
      } catch (error) {
        // Infrastructure failure (never a model refusal).
        const detail = error instanceof Error ? error.message : 'Freebuff request failed';
        await client.notify(CLIENT_METHODS.session_update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Freebuff bridge error: ${detail}` } } }).catch(() => undefined);
        return { stopReason: 'end_turn' as const };
      } finally {
        unsubscribe();
        sessions.unregisterController(handle.turn.id);
      }
    });

  const stream = ndJsonStream(Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const connection = app.connect(stream);
  const cleanup = () => {
    for (const session of acpSessions.values()) {
      session.controller.abort();
      void turns.cancelTurn(session.bridgeSessionId).catch(() => undefined);
    }
    sessions.dispose();
    connection.close();
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
}

export { isTerminalTurnState };

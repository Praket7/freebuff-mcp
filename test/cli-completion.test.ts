import assert from 'node:assert/strict';
import test from 'node:test';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CliBackend } from '../src/backends/cli-backend.js';
import { CliPtyManager, readCliConversationSnapshot, readCliTurnMarkers, waitForCliTurnEnd } from '../src/pty.js';

/**
 * P0: the CLI must never invent completion.
 *
 * Completion requires a POST-SUBMIT terminal transition in the chat store
 * (run-state.json / log.jsonl). Stale idle states, pre-existing messages,
 * timeouts, aborts, and missing conversation ids must never read as
 * `completed`.
 */

function projectKey(cwd: string): string {
  return `${path.basename(cwd)}--${createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12)}`;
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-cli-home-'));
  const previousHome = process.env.HOME;
  const previousKey = process.env.FREEBUFF_PROJECT_KEY;
  process.env.HOME = home;
  delete process.env.FREEBUFF_PROJECT_KEY;
  // os.homedir() may be cached/mocked; point it at the fixture home too.
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => home;
  try {
    return await fn(home);
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousKey === undefined) delete process.env.FREEBUFF_PROJECT_KEY; else process.env.FREEBUFF_PROJECT_KEY = previousKey;
    await fs.rm(home, { recursive: true, force: true });
  }
}

interface ConvOpts {
  runState?: unknown;
  messages?: unknown[];
  meta?: Record<string, unknown>;
}

async function makeConv(home: string, cwd: string, convId: string, opts: ConvOpts = {}): Promise<string> {
  const dir = path.join(home, '.config', 'manicode', 'projects', projectKey(cwd), 'chats', convId);
  await fs.mkdir(dir, { recursive: true });
  const messages = opts.messages ?? [];
  await fs.writeFile(dir + '/log.jsonl', `${messages.map((m) => JSON.stringify(m)).join('\n')}${messages.length ? '\n' : ''}`, 'utf8');
  if (opts.runState !== undefined) await fs.writeFile(path.join(dir, 'run-state.json'), JSON.stringify(opts.runState), 'utf8');
  await fs.writeFile(path.join(dir, 'chat-meta.json'), JSON.stringify({ firstPrompt: 'do the thing', messageCount: messages.length, ...(opts.meta ?? {}) }), 'utf8');
  return dir;
}

const userMsg = { role: 'user', parts: [{ type: 'text', text: 'do the thing' }] };
const assistantMsg = { role: 'assistant', parts: [{ type: 'text', text: 'done' }] };

test('cli completion: a long turn cannot finish before its terminal transition', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-long-1';
    await makeConv(home, cwd, conv, { runState: { mainAgentState: { turnState: 'running' } }, messages: [userMsg] });
    const baseline = await readCliTurnMarkers(cwd, conv);
    assert.ok(baseline.logBytes > 0);

    const waited = waitForCliTurnEnd(cwd, conv, baseline, undefined, 5_000);
    // The store still says running: 250ms must not be enough to "complete".
    await new Promise((r) => setTimeout(r, 250));
    // Flip to terminal AFTER the wait started, with a new message.
    const dir = path.join(home, '.config', 'manicode', 'projects', projectKey(cwd), 'chats', conv);
    await fs.writeFile(path.join(dir, 'run-state.json'), JSON.stringify({ mainAgentState: { turnState: 'idle' } }), 'utf8');
    await fs.appendFile(path.join(dir, 'log.jsonl'), `${JSON.stringify(assistantMsg)}\n`, 'utf8');

    const started = Date.now();
    const end = await waited;
    assert.equal(end.state, 'completed');
    assert.equal(end.proven, true);
    assert.ok(Date.now() - started < 5_000, 'resolved promptly after the real transition');
  });
});

test('cli completion: stale idle state plus old messages never reads as completed', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-stale-1';
    await makeConv(home, cwd, conv, { runState: { mainAgentState: { turnState: 'idle' } }, messages: [userMsg, assistantMsg] });
    // Baseline taken AFTER everything already happened: nothing post-submit.
    const baseline = await readCliTurnMarkers(cwd, conv);
    const end = await waitForCliTurnEnd(cwd, conv, baseline, undefined, 1_200);
    assert.equal(end.state, 'waiting_for_user');
    assert.equal(end.proven, false);
    assert.match(end.error ?? '', /unconfirmed/i);
  });
});

test('cli completion: a post-submit assistant lastMessage proves completion without a turnState field', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-last-message';
    const oldMessage = { type: 'lastMessage', value: [{ role: 'assistant', text: 'old', sentAt: new Date(Date.now() - 60_000).toISOString() }] };
    await makeConv(home, cwd, conv, { runState: { sessionState: { fileContext: {}, mainAgentState: { runId: 'old-run' } }, output: oldMessage }, messages: [userMsg, assistantMsg] });
    const baseline = await readCliTurnMarkers(cwd, conv);
    const dir = path.join(home, '.config', 'manicode', 'projects', projectKey(cwd), 'chats', conv);
    const waiting = waitForCliTurnEnd(cwd, conv, baseline, undefined, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.writeFile(path.join(dir, 'run-state.json'), JSON.stringify({
      sessionState: { fileContext: {}, mainAgentState: { runId: 'new-run', stepsRemaining: 0 } },
      output: { type: 'lastMessage', value: [{ role: 'assistant', text: 'READY', sentAt: new Date().toISOString() }] },
    }), 'utf8');
    const result = await waiting;
    assert.deepEqual(result, { state: 'completed', proven: true });
  });
});

test('cli completion: a post-submit Main prompt finished log entry proves completion', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-prompt-finished';
    await makeConv(home, cwd, conv, { runState: { sessionState: { mainAgentState: { runId: 'run-1' } } }, messages: [userMsg] });
    const baseline = await readCliTurnMarkers(cwd, conv);
    const dir = path.join(home, '.config', 'manicode', 'projects', projectKey(cwd), 'chats', conv);
    const waiting = waitForCliTurnEnd(cwd, conv, baseline, undefined, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.appendFile(path.join(dir, 'log.jsonl'), `${JSON.stringify({ message: 'Main prompt finished' })}\n`, 'utf8');
    const result = await waiting;
    assert.deepEqual(result, { state: 'completed', proven: true });
  });
});

test('cli completion: a post-submit session-over log fails instead of waiting for timeout', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-session-over';
    await makeConv(home, cwd, conv, { runState: { sessionState: { mainAgentState: { runId: 'run-1' } } }, messages: [userMsg] });
    const baseline = await readCliTurnMarkers(cwd, conv);
    const dir = path.join(home, '.config', 'manicode', 'projects', projectKey(cwd), 'chats', conv);
    const waiting = waitForCliTurnEnd(cwd, conv, baseline, undefined, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.appendFile(path.join(dir, 'log.jsonl'), `${JSON.stringify({ message: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' })}\n`, 'utf8');
    const result = await waiting;
    assert.equal(result.state, 'failed');
    assert.equal(result.proven, true);
    assert.match(result.error ?? '', /FREEBUFF_SESSION_OVER/);
  });
});

test('cli startup allows the normal idle-session log line before the first message', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-session-over-start';
    await makeConv(home, cwd, conv, {
      messages: [
        { msg: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' },
        { msg: 'Enhanced CLI fingerprint generated successfully' },
      ],
    });
    const manager = new CliPtyManager();
    const session = {
      term: { pid: process.pid, write: () => undefined, kill: () => undefined },
      cwd,
      startedAt: Date.now(),
      conversationId: conv,
      output: '[chat-runtime] Freebuff session over; holding queued messages until rejoin',
      screen: { text: () => 'Your first message starts the session. Enter a coding task or / for commands' },
      exited: false,
    };
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set('pty-session-over', session);
    try {
      const result = await manager.start('pty-session-over', cwd);
      assert.equal(result.id, 'pty-session-over');
    } finally {
      manager.dispose();
    }
  });
});

test('cli startup rejects a crash-resumed hour that is explicitly waiting to rejoin', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-crash-resume';
    await makeConv(home, cwd, conv, {
      messages: [
        { msg: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' },
        { via: 'crash', msg: '[freebuff-session] resuming the hour a previous CLI left behind' },
      ],
    });
    const manager = new CliPtyManager();
    const session = {
      term: { pid: process.pid, write: () => undefined, kill: () => undefined },
      cwd,
      startedAt: Date.now(),
      conversationId: conv,
      output: '',
      screen: { text: () => 'Enter a coding task or / for commands' },
      exited: false,
    };
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set('pty-crash-resume', session);
    try {
      await assert.rejects(() => manager.start('pty-crash-resume', cwd), /FREEBUFF_SESSION_OVER/);
    } finally {
      manager.dispose();
    }
  });
});

test('cli startup ignores crash-recovery markers that predate this PTY process', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-stale-crash-resume';
    const dir = await makeConv(home, cwd, conv, {
      messages: [
        { msg: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' },
        { via: 'crash', msg: '[freebuff-session] resuming the hour a previous CLI left behind' },
      ],
    });
    const startupLogBytes = (await fs.stat(path.join(dir, 'log.jsonl'))).size;
    await fs.appendFile(path.join(dir, 'log.jsonl'), `${JSON.stringify({ msg: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' })}\n`);
    const manager = new CliPtyManager();
    const session = {
      term: { pid: process.pid, write: () => undefined, kill: () => undefined },
      cwd,
      startedAt: Date.now(),
      conversationId: conv,
      startupLogBytes,
      output: '[chat-runtime] Freebuff session over; holding queued messages until rejoin',
      screen: { text: () => 'Your first message starts the session. Enter a coding task or / for commands' },
      exited: false,
    };
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set('pty-stale-crash', session);
    try {
      const result = await manager.start('pty-stale-crash', cwd);
      assert.equal(result.id, 'pty-stale-crash');
    } finally {
      manager.dispose();
    }
  });
});

test('cli submit baseline is captured after paste and before Enter', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-submit-baseline';
    const dir = await makeConv(home, cwd, conv, {
      messages: [{ msg: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' }],
    });
    const initialBytes = (await fs.stat(path.join(dir, 'log.jsonl'))).size;
    const manager = new CliPtyManager();
    let baseline: { capturedAtMs: number; runStateMtimeMs: number; logBytes: number; logMtimeMs: number } | undefined;
    const session = {
      term: {
        pid: process.pid,
        write: (data: string) => {
          if (data === '\r') {
            fsSync.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ msg: '[chat-runtime] Freebuff session over; holding queued messages until rejoin' })}\n`);
          }
        },
        kill: () => undefined,
      },
      cwd,
      startedAt: Date.now(),
      conversationId: conv,
      output: '',
      screen: { text: () => 'Enter a coding task or / for commands' },
      exited: false,
    };
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set('pty-submit-baseline', session);
    try {
      const result = await manager.send('pty-submit-baseline', 'run a small task', cwd, undefined, (markers) => { baseline = markers; });
      assert.equal(result.conversationId, conv);
      assert.equal(baseline?.logBytes, initialBytes);
      assert.ok((await fs.stat(path.join(dir, 'log.jsonl'))).size > initialBytes);
    } finally {
      manager.dispose();
    }
  });
});

test('cli completion: a same-size log update proves the terminal transition', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-same-size-log';
    const initial = { role: 'assistant', parts: [{ type: 'text', text: 'old' }] };
    await makeConv(home, cwd, conv, { runState: { mainAgentState: { turnState: 'idle' } }, messages: [userMsg, initial] });
    const baseline = await readCliTurnMarkers(cwd, conv);
    const dir = path.join(home, '.config', 'manicode', 'projects', projectKey(cwd), 'chats', conv);
    const before = await fs.stat(path.join(dir, 'log.jsonl'));
    const started = waitForCliTurnEnd(cwd, conv, baseline, undefined, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const replacement = { role: 'assistant', parts: [{ type: 'text', text: 'new' }] };
    await fs.writeFile(path.join(dir, 'log.jsonl'), `${JSON.stringify(userMsg)}\n${JSON.stringify(replacement)}\n`, 'utf8');
    const later = new Date(Math.max(Date.now(), before.mtimeMs + 2_000));
    await fs.utimes(path.join(dir, 'log.jsonl'), later, later);
    const result = await started;
    assert.equal(result.state, 'completed');
    assert.equal(result.proven, true);
  });
});

test('cli completion: abort reads as cancelled, never completed', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-abort-1';
    await makeConv(home, cwd, conv, { runState: { mainAgentState: { turnState: 'running' } }, messages: [userMsg] });
    const baseline = await readCliTurnMarkers(cwd, conv);
    const controller = new AbortController();
    const waited = waitForCliTurnEnd(cwd, conv, baseline, controller.signal, 10_000);
    setTimeout(() => controller.abort(), 200);
    const end = await waited;
    assert.equal(end.state, 'cancelled');
  });
});

test('cli completion: a natively cancelled store transition reads as cancelled', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-native-cancel-1';
    await makeConv(home, cwd, conv, { runState: { mainAgentState: { turnState: 'running' } }, messages: [userMsg] });
    const baseline = await readCliTurnMarkers(cwd, conv);
    const waited = waitForCliTurnEnd(cwd, conv, baseline, undefined, 5_000);
    await new Promise((r) => setTimeout(r, 250));
    const dir = path.join(home, '.config', 'manicode', 'projects', projectKey(cwd), 'chats', conv);
    await fs.writeFile(path.join(dir, 'run-state.json'), JSON.stringify({ mainAgentState: { turnState: 'cancelled' } }), 'utf8');
    await fs.appendFile(path.join(dir, 'log.jsonl'), `${JSON.stringify(assistantMsg)}\n`, 'utf8');
    const end = await waited;
    assert.equal(end.state, 'cancelled', 'native cancellation must never map to completed');
    assert.equal(end.proven, true);
  });
});

test('cli completion: sendMessage without a conversation id is unconfirmed, not completed', async () => {
  const backend = new CliBackend('/tmp/project');
  (backend as unknown as { manager: unknown }).manager = {
    send: async (id: string) => ({ id, pid: 1, output: 'stub', exited: false }),
    snapshot: () => { throw new Error('FREEBUFF_CLI_SESSION_NOT_FOUND'); },
    dispose: () => undefined,
  };
  const result = await backend.sendMessage({ session: { id: 'pty-1', backend: 'cli', cwd: '/tmp/project' }, text: 'hello' });
  assert.equal(result.state, 'waiting_for_user');
  assert.match(String(result.error ?? ''), /no conversation id/i);
});

test('cli stop: a cancelled turn keeps its healthy PTY alive (no hard kill)', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-stop-1';
    // The turn already went idle in the store: cancellation is confirmed.
    await makeConv(home, cwd, conv, { runState: { mainAgentState: { turnState: 'idle' } }, messages: [userMsg, assistantMsg] });
    const backend = new CliBackend(cwd);
    const calls: string[] = [];
    (backend as unknown as { manager: unknown }).manager = {
      stop: (id: string) => { calls.push(`stop:${id}`); return { id, pid: 1, output: '', exited: false }; },
      snapshot: (id: string) => { calls.push(`snapshot:${id}`); return { id, pid: 1, output: '', exited: false }; },
      kill: (id: string) => { calls.push(`kill:${id}`); },
      dispose: () => undefined,
    };
    await backend.stop({ id: 'pty-1', backend: 'cli', backendSessionId: conv, cwd });
    assert.ok(calls.some((c) => c === 'stop:pty-1'), 'the interrupt was delivered');
    assert.ok(!calls.some((c) => c.startsWith('kill:')), `a healthy session must not be killed: ${calls.join(',')}`);
  });
});

test('cli stop: an unconfirmed turn escalates to a hard kill', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-stop-2';
    // The store still says running: cancellation cannot be confirmed.
    await makeConv(home, cwd, conv, { runState: { mainAgentState: { turnState: 'running' } }, messages: [userMsg] });
    const backend = new CliBackend(cwd);
    const calls: string[] = [];
    (backend as unknown as { manager: unknown }).manager = {
      stop: (id: string) => { calls.push(`stop:${id}`); return { id, pid: 1, output: '', exited: false }; },
      snapshot: (id: string) => { calls.push(`snapshot:${id}`); return { id, pid: 1, output: '', exited: false }; },
      kill: (id: string) => { calls.push(`kill:${id}`); },
      dispose: () => undefined,
    };
    await backend.stop({ id: 'pty-1', backend: 'cli', backendSessionId: conv, cwd });
    assert.ok(calls.some((c) => c === 'kill:pty-1'), `a stuck turn must be killed: ${calls.join(',')}`);
  });
});

test('cli snapshot: an object mainAgentState never becomes the turnState string', async () => {
  await withHome(async (home) => {
    const cwd = path.join(home, 'proj');
    const conv = 'conv-shape-1';
    await makeConv(home, cwd, conv, { runState: { mainAgentState: { turnState: 'running', nested: { deep: true } } }, messages: [userMsg] });
    const snapshot = await readCliConversationSnapshot(cwd, conv);
    assert.equal(snapshot.turnState, 'running');

    const conv2 = 'conv-shape-2';
    await makeConv(home, cwd, conv2, { runState: { mainAgentState: { nested: { deep: true } } }, messages: [userMsg] });
    const snapshot2 = await readCliConversationSnapshot(cwd, conv2);
    assert.ok(!('turnState' in snapshot2), 'no string state available means no turnState field at all');
  });
});

test('cli listings: two simultaneous projects list and read the right conversations', async () => {
  await withHome(async (home) => {
    const cwdA = path.join(home, 'proja');
    const cwdB = path.join(home, 'projb');
    await makeConv(home, cwdA, 'conv-a', { runState: { turnState: 'idle' }, messages: [userMsg], meta: { firstPrompt: 'prompt A' } });
    await makeConv(home, cwdB, 'conv-b', { runState: { turnState: 'idle' }, messages: [userMsg], meta: { firstPrompt: 'prompt B' } });
    const backend = new CliBackend(cwdA);
    backend.registerConversationRoot('conv-b', cwdB);

    const projects = (await backend.listProjects()) as Array<{ id: string }>;
    assert.ok(projects.some((p) => p.id === cwdA), 'constructor root listed');
    assert.ok(projects.some((p) => p.id === cwdB), 'second served root listed');

    const threads = (await backend.listThreads()) as Array<{ id: string; firstPrompt?: string }>;
    const ids = threads.map((t) => t.id);
    assert.ok(ids.includes('conv-a'), `conv-a listed: ${ids.join(',')}`);
    assert.ok(ids.includes('conv-b'), `conv-b listed: ${ids.join(',')}`);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate conversations');
  });
});

test('cli reads: conversations resolve through their owning project root', async () => {
  await withHome(async (home) => {
    const cwdA = path.join(home, 'proja');
    const cwdB = path.join(home, 'projb');
    await makeConv(home, cwdA, 'conv-a', { runState: { turnState: 'idle' }, messages: [userMsg], meta: { firstPrompt: 'prompt A' } });
    await makeConv(home, cwdB, 'conv-b', { runState: { turnState: 'idle' }, messages: [userMsg], meta: { firstPrompt: 'prompt B' } });
    const backend = new CliBackend(cwdA);
    backend.registerConversationRoot('conv-b', cwdB);
    const threadB = (await backend.getThread('conv-b')) as { firstPrompt?: string };
    assert.equal(threadB.firstPrompt, 'prompt B', 'conv-b reads from projb, not the constructor root');
    const threadA = (await backend.getThread('conv-a')) as { firstPrompt?: string };
    assert.equal(threadA.firstPrompt, 'prompt A');
  });
});

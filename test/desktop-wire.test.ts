import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopBackend } from '../src/backends/desktop-backend.js';
import { CompositeBackend } from '../src/backends/backend.js';

/**
 * Wire-contract tests for the real Freebuff Desktop HTTP API.
 *
 * Every fixture below was captured from a live Freebuff Desktop (see
 * docs/compatibility.md). CI has no Desktop installed, so these fixtures are
 * the only thing standing between us and a silently wrong HTTP contract — the
 * shapes here are deliberately the REAL ones, including the wrappers and the
 * nested thread lists that a naive implementation would get wrong.
 */

const THREAD_ID = '91c7739f-45fa-46a5-b653-120a85a63838';
const PROJECT_PATH = '/Users/example/proj';
const LAUNCH_ID = 'launch-fixture-id';

/**
 * These tests must not depend on a Desktop installed on the machine running
 * them. An earlier revision called `new DesktopBackend()` with no options, so
 * discovery ran against the real machine: locally it found a live Desktop and
 * the mocked fetch happily answered, while CI (no Desktop) failed with
 * FREEBUFF_DESKTOP_NOT_FOUND. Pin the origin explicitly, and hard-fail on any
 * foreign origin so a live dependency can never silently come back.
 */
const WIRE_ORIGIN = 'http://127.0.0.1:38211';

function wireBackend(): DesktopBackend {
  return new DesktopBackend({ baseUrl: WIRE_ORIGIN, explicitLaunchId: LAUNCH_ID });
}

/** Real `/api/projects`: an array of PROJECTS, each with a nested `threads`. */
const REAL_PROJECTS = {
  projects: [
    {
      path: PROJECT_PATH,
      threads: [
        {
          id: THREAD_ID,
          projectId: PROJECT_PATH,
          projectPath: PROJECT_PATH,
          title: 'Drone Validation Workflow Setup',
          status: 'closed',
          harnessId: 'codebuff',
          model: 'z-ai/glm-5.3-flash',
          reasoningEffort: null,
          agentMode: 'build',
          executionMode: 'local',
          branch: null,
          worktreePath: null,
          turnState: 'idle',
          queuePaused: false,
          briefs: [],
          stopping: false,
          createdAt: 1788199454247,
          updatedAt: 1788199473289,
        },
      ],
    },
  ],
};

/** Real `/api/thread/:id`: `{ thread, messages, items }` — NOT a flat thread. */
const REAL_THREAD = {
  thread: {
    id: THREAD_ID,
    projectId: PROJECT_PATH,
    projectPath: PROJECT_PATH,
    title: 'Drone Validation Workflow Setup',
    status: 'closed',
    harnessId: 'codebuff',
    model: 'z-ai/glm-5.3-flash',
    turnState: 'idle',
  },
  messages: [
    { role: 'user', parts: [{ type: 'text', text: 'hello' }], attachments: [{ path: '/tmp/spec.md', name: 'spec.md' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
  ],
  items: [{ id: 'queue-item-1', kind: 'queued' }],
};

/** Real `/api/thread/:id/changes`. */
const REAL_CHANGES = {
  scope: 'all',
  branch: null,
  files: [{ path: 'src/a.ts', adds: 3, dels: 1, modifiedAt: 1788199473289, untracked: false }],
  totals: { files: 1, adds: 3, dels: 1 },
};

/** Real `/api/thread/:id/changes/diff` success shape is `{ patch }`. */
const REAL_DIFF = { patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,3 @@\n-old\n+new\n+more\n' };

interface Captured { method: string; path: string; body?: unknown }

function mockDesktop(overrides: Record<string, (req: Captured) => Response | undefined> = {}): { calls: Captured[]; restore: () => void; previousLaunch: string | undefined } {
  const previous = globalThis.fetch;
  const previousLaunch = process.env.FREEBUFF_LAUNCH_ID;
  process.env.FREEBUFF_LAUNCH_ID = LAUNCH_ID;
  const calls: Captured[] = [];
  const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== WIRE_ORIGIN) throw new Error(`wire test attempted a real network call to ${url.origin}; it must stay hermetic`);
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Captured = { method, path: url.pathname + url.search, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    for (const handler of Object.values(overrides)) {
      const response = handler(call);
      if (response) return response;
    }
    if (url.pathname === '/api/projects') return json(REAL_PROJECTS);
    if (url.pathname === '/healthz') return json({ ok: true, launchId: LAUNCH_ID, pid: 1, port: 1 });
    if (url.pathname === `/api/thread/${THREAD_ID}`) return json(REAL_THREAD);
    if (url.pathname === `/api/thread/${THREAD_ID}/changes`) return json(REAL_CHANGES);
    if (url.pathname === `/api/thread/${THREAD_ID}/changes/diff`) return json(REAL_DIFF);
    if (url.pathname === '/api/threads') return json({ id: 'new-thread-id', projectId: PROJECT_PATH, projectPath: PROJECT_PATH, title: 'New thread', draft: true });
    if (url.pathname.endsWith('/message')) return json({ ok: true, itemId: 'item-1' });
    return json({ error: 'not found' }, 404);
  };
  return {
    calls,
    previousLaunch,
    restore: () => {
      globalThis.fetch = previous;
      if (previousLaunch === undefined) delete process.env.FREEBUFF_LAUNCH_ID;
      else process.env.FREEBUFF_LAUNCH_ID = previousLaunch;
    },
  };
}

test('wire: listThreads flattens projects into threads (never returns projects)', async () => {
  const mock = mockDesktop();
  const backend = wireBackend();
  try {
    const threads = (await backend.listThreads()) as Array<Record<string, unknown>>;
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.id, THREAD_ID);
    assert.equal(threads[0]?.turnState, 'idle', 'exposes thread fields, not project fields');
    assert.equal(threads[0]?.projectPath, PROJECT_PATH);
    assert.equal('threads' in (threads[0] ?? {}), false, 'must not leak the nested project array');
  } finally {
    backend.dispose();
    mock.restore();
  }
});

test('wire: getThread unwraps {thread,messages,items} so metadata is not lost', async () => {
  const mock = mockDesktop();
  const backend = wireBackend();
  try {
    const thread = (await backend.getThread(THREAD_ID)) as Record<string, unknown>;
    assert.equal(thread.id, THREAD_ID);
    assert.equal(thread.title, 'Drone Validation Workflow Setup');
    assert.equal(thread.turnState, 'idle');
    assert.equal(thread.model, 'z-ai/glm-5.3-flash');
    assert.equal(Array.isArray(thread.messages), true, 'messages are flattened to the top level');
    assert.equal((thread.messages as unknown[]).length, 2);
    assert.equal(Array.isArray(thread.items), true, 'queue items are preserved');
    assert.equal('thread' in thread, false, 'the raw wrapper is never forwarded');
  } finally {
    backend.dispose();
    mock.restore();
  }
});

test('wire: getMessages returns real messages from the snapshot wrapper', async () => {
  const mock = mockDesktop();
  const backend = wireBackend();
  try {
    const messages = (await backend.getMessages(THREAD_ID)) as unknown[];
    assert.equal(messages.length, 2);
  } finally {
    backend.dispose();
    mock.restore();
  }
});

test('wire: listAttachments reads message attachments and never calls the single-file /attachment route', async () => {
  const mock = mockDesktop();
  const backend = wireBackend();
  try {
    const attachments = (await backend.listAttachments(THREAD_ID)) as Array<Record<string, unknown>>;
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]?.path, '/tmp/spec.md');
    assert.equal(mock.calls.some((c) => c.path.startsWith(`/api/thread/${THREAD_ID}/attachment`)), false, 'the /attachment route requires ?path and cannot list');
  } finally {
    backend.dispose();
    mock.restore();
  }
});

test('wire: createSession uses POST /api/threads and returns the real new thread id', async () => {
  const mock = mockDesktop();
  const backend = wireBackend();
  try {
    const session = await backend.createSession!({ cwd: PROJECT_PATH });
    assert.equal(session.backend, 'desktop');
    assert.equal(session.backendSessionId, 'new-thread-id');
    const create = mock.calls.find((c) => c.method === 'POST' && c.path === '/api/threads');
    assert.ok(create, 'POST /api/threads was used');
    assert.deepEqual(create?.body, { projectPath: PROJECT_PATH });
  } finally {
    backend.dispose();
    mock.restore();
  }
});

test('wire: createSession with continueBackendId verifies the thread exists instead of guessing', async () => {
  const mock = mockDesktop();
  const backend = wireBackend();
  try {
    const session = await backend.createSession!({ cwd: PROJECT_PATH, continueBackendId: THREAD_ID });
    assert.equal(session.backendSessionId, THREAD_ID);
    assert.equal(mock.calls.some((c) => c.method === 'POST' && c.path === '/api/threads'), false, 'an existing thread is reused, not recreated');
  } finally {
    backend.dispose();
    mock.restore();
  }
});

test('wire: getDiff sends file+scope and parses the real {patch} response', async () => {
  const mock = mockDesktop();
  const backend = wireBackend();
  try {
    const diff = (await backend.getDiff(THREAD_ID, 'src/a.ts', 'all')) as Record<string, unknown>;
    assert.match(String(diff.patch), /^diff --git/);
    const call = mock.calls.find((c) => c.path.includes('/changes/diff'));
    assert.ok(call, 'the changes/diff route was used');
    assert.match(call!.path, /file=src%2Fa\.ts/);
    assert.match(call!.path, /scope=all/);
    await assert.rejects(() => backend.getDiff(THREAD_ID, '', 'all'), /file path is required/i);
  } finally {
    backend.dispose();
    mock.restore();
  }
});

test('wire: a Desktop that cannot create sessions fails with a structured error, never a TypeError', async () => {
  const mock = mockDesktop();
  const composite = new CompositeBackend({ desktop: { createSession: undefined, dispose: () => undefined, probe: async () => ({ backend: 'desktop', connection: 'connected_writable', authorization: 'write_authorized', liveProgress: 'connected', canCreateSession: false, canSendMessage: true, canStop: true, canResume: true, canSetModel: true, canSetReasoning: true, notes: [] }) } as unknown as DesktopBackend });
  try {
    await assert.rejects(
      () => composite.createSession({ cwd: PROJECT_PATH }),
      (error: unknown) => {
        assert.equal((error as { name?: string }).name, 'BridgeError', 'structured bridge error, not a TypeError');
        assert.match(String((error as Error).message), /cannot create new sessions/);
        return true;
      },
    );
  } finally {
    composite.dispose();
    mock.restore();
  }
});

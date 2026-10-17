import { ConversationControl } from '../../src/server/chat/documents';
import { remoteActionSource } from '../../src/extensions/async-example/contracts';
import { abortAllDurableObjects } from 'cloudflare:test';
import { env, runInDurableObject } from './env';
import { expect, it, vi } from 'vitest';
import { RemoteIntents, type RemoteIntent } from '../../src/extensions/async-example/runtime';
import { BG } from '../../src/server/chat/context';

it('native owned child state survives eviction; known IDs are queried without another remote submission', async () => {
  let submits = 0,
    queries = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      submits++;
      return Response.json({ id: 'original-job' });
    }
    queries++;
    return Response.json(
      queries > 1 ? { status: 'completed', result: { value: 42 } } : { status: 'pending' },
    );
  });
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  try {
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE test_remote (mode TEXT)');
      state.storage.sql.exec("INSERT INTO test_remote VALUES('key')");
    });
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    let deadline = 0;
    for (let i = 0; i < 100; i++) {
      const operations = await runInDurableObject(
        stub,
        async (instance) =>
          (
            await (
              await instance.harness.pi()
            ).snapshot(RemoteIntents, (await instance.root()).id, BG)
          )?.operations,
      );
      const operation = Object.values(operations ?? {})[0] as RemoteIntent | undefined;
      if (operation?.remoteId) {
        deadline = operation.deadline;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(deadline).toBeGreaterThan(Date.now());
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    expect(Object.values(await operations(stub))[0].deadline).toBe(deadline);
    for (let i = 0; i < 200; i++) {
      const snapshot = JSON.parse(await stub.snapshot());
      if (!snapshot.pending.length) {
        expect(JSON.stringify(snapshot.entries)).toContain('42');
        expect(submits).toBe(1);
        expect(queries).toBeGreaterThan(1);
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('Child task did not recover');
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function operations(stub: ReturnType<typeof env.CONVERSATIONS.getByName>) {
  return runInDurableObject(
    stub,
    async (instance) =>
      (await (await instance.harness.pi()).snapshot(RemoteIntents, (await instance.root()).id, BG))
        ?.operations ?? {},
  );
}
async function waitUntil(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await pause(20);
  }
  throw new Error('Remote fixture did not settle');
}
async function setup(mode: string, waitMs = 5000) {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec('CREATE TABLE test_remote (mode TEXT, wait_ms INTEGER)');
    state.storage.sql.exec('INSERT INTO test_remote VALUES(?,?)', mode, waitMs);
  });
  return stub;
}
it('commits the entire bounded remote result to Pi history and retains it after reconstruction', async () => {
  const value = { text: 'x'.repeat(64 * 1024), tail: 'complete-result' };
  let submits = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      submits++;
      return Response.json({ id: 'large-result' });
    }
    return Response.json({ status: 'completed', result: value });
  });
  let stub = await setup('key');
  const result = async () => {
    const snapshot = JSON.parse(await stub.snapshot());
    return snapshot.entries
      .flatMap((entry: any) => entry.model ?? [])
      .find(
        (message: any) => message.role === 'toolResult' && message.toolName === 'example_generate',
      );
  };
  try {
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect((await result()).isError).toBe(false);
    expect(JSON.parse((await result()).content[0].text)).toEqual({ ok: true, value });
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    expect(JSON.parse((await result()).content[0].text)).toEqual({ ok: true, value });
    expect(submits).toBe(1);
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});
it.each(['key', 'lookup', 'none'] as const)(
  'accepted-without-ID gap survives eviction (%s recovery)',
  async (mode) => {
    let submits = 0;
    const keys: string[] = [];
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        submits++;
        keys.push(request.headers.get('Idempotency-Key')!);
        if (submits === 1) {
          await new Promise<void>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('lost response')), 2000);
            request.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('evicted'));
              },
              { once: true },
            );
          });
        }
        return Response.json({ id: 'same-operation' });
      }
      if (new URL(request.url).searchParams.has('key'))
        return Response.json({ id: 'same-operation' });
      return Response.json({ status: 'completed', result: { recovered: true } });
    });
    let stub = await setup(mode);
    try {
      await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
      await waitUntil(async () => submits === 1);
      const deadline = Object.values(await operations(stub))[0].deadline;
      await abortAllDurableObjects();
      stub = env.CONVERSATIONS.get(stub.id);
      await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
      const op = Object.values(await operations(stub))[0];
      expect(op.deadline).toBe(deadline);
      expect(op.status).toBe(mode === 'none' ? 'unknown' : 'completed');
      expect(new Set(keys).size).toBe(1);
      expect(submits).toBe(mode === 'key' ? 2 : 1);
      if (mode === 'none') {
        await stub.submitRun({
          runId: crypto.randomUUID(),
          text: 'remote example changed arguments',
        });
        await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
        expect(submits).toBe(1);
        expect(Object.keys(await operations(stub))).toHaveLength(1);
      }
    } finally {
      await abortAllDurableObjects();
      network.mockRestore();
    }
  },
);
it('absolute deadline survives restart; unsupported cancellation retains the reference and truthful remote status', async () => {
  let submits = 0,
    cancels = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      submits++;
      return Response.json({ id: 'running-job' });
    }
    if (request.method === 'DELETE') {
      cancels++;
      return new Response(null, { status: 405 });
    }
    return Response.json({ status: 'pending' });
  });
  try {
    let stub = await setup('key', 300);
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !!Object.values(await operations(stub))[0]?.remoteId);
    const deadline = Object.values(await operations(stub))[0].deadline;
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(Object.values(await operations(stub))[0]).toMatchObject({
      deadline,
      status: 'timeout',
      remoteId: 'running-job',
    });
    expect(submits).toBe(1);
    const stopping = await setup('key');
    await stopping.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !!Object.values(await operations(stopping))[0]?.remoteId);
    await stopping.stopConversation();
    await waitUntil(async () => {
      const s = JSON.parse(await stopping.snapshot());
      return !s.stopping && !s.pending.length;
    });
    expect(cancels).toBe(1);
    expect(Object.values(await operations(stopping))[0]).toMatchObject({
      status: 'cancel_unsupported',
      remoteId: 'running-job',
      remoteStatus: 'pending',
    });
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

it('only explicit retry authorizes one new operation with original inputs; readonly recheck never submits', async () => {
  let submits = 0;
  const prompts: string[] = [];
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      submits++;
      prompts.push(((await request.json()) as any).prompt);
      if (submits === 1) throw new Error('accepted response lost');
      return Response.json({ id: 'explicit-new-operation' });
    }
    return Response.json({ status: 'completed', result: { value: 9 } });
  });
  const stub = await setup('none');
  try {
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    const original = Object.values(await operations(stub))[0];
    const alien = await setup('none');
    expect(
      await alien.submitRun({
        runId: crypto.randomUUID(),
        text: 'retry',
        source: remoteActionSource('retry', original.taskId),
      }),
    ).toMatchObject({ error: { code: 'remote_reference_not_found', status: 404 } });
    await stub.submitRun({
      runId: crypto.randomUUID(),
      text: 'recheck',
      source: remoteActionSource('recheck', original.taskId),
    });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(submits).toBe(1);
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'ordinary read-only answer' });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(JSON.stringify(JSON.parse(await stub.snapshot()).entries)).toContain(
      'ordinary read-only answer',
    );
    expect(JSON.parse(await stub.snapshot()).entries.at(-1).model[0].stopReason).not.toBe('error');
    const retry = {
      runId: crypto.randomUUID(),
      text: 'retry',
      source: remoteActionSource('retry', original.taskId),
    };
    await Promise.all([stub.submitRun(retry), stub.submitRun(retry)]);
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(submits).toBe(2);
    expect(prompts).toEqual(['hello', 'hello']);
    expect(Object.values(await operations(stub))).toHaveLength(2);
    const snapshot = JSON.parse(await stub.snapshot());
    expect(snapshot.extensionState['async-example']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: original.taskId, status: 'unknown' }),
      ]),
    );
    expect(JSON.stringify(snapshot.extensionState['async-example'])).not.toContain(
      'explicit-new-operation',
    );
    expect(JSON.stringify(snapshot.extensionState['async-example'])).not.toContain('fingerprint');
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example bypass' });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(submits).toBe(2);
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

it('readonly recheck exposes only status and result, not supplier references or response metadata', async () => {
  let completed = false;
  let submits = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      submits++;
      return Response.json({ id: 'server-private-job-id' });
    }
    if (request.method === 'DELETE') return new Response(null, { status: 405 });
    return Response.json({
      id: 'server-private-job-id',
      providerMetadata: 'internal-supplier-metadata',
      status: completed ? 'completed' : 'pending',
      ...(completed ? { result: { answer: 9 } } : {}),
    });
  });
  const stub = await setup('none');
  try {
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !!Object.values(await operations(stub))[0]?.remoteId);
    await stub.stopConversation();
    await waitUntil(async () => {
      const state = JSON.parse(await stub.snapshot());
      return !state.pending.length && !state.stopping;
    });
    completed = true;
    const original = Object.values(await operations(stub))[0];
    await stub.submitRun({
      runId: crypto.randomUUID(),
      text: 'recheck',
      source: remoteActionSource('recheck', original.taskId),
    });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    const history = JSON.stringify(JSON.parse(await stub.snapshot()).entries);
    expect(history).toContain('answer');
    expect(history).not.toContain('server-private-job-id');
    expect(history).not.toContain('internal-supplier-metadata');
    expect(submits).toBe(1);
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

it('readonly recheck preserves an unresolved reference when completion has no result', async () => {
  let rechecking = false;
  let includeResult = false;
  let submits = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      submits++;
      return Response.json({ id: 'original-job' });
    }
    if (request.method === 'DELETE') return new Response(null, { status: 405 });
    return Response.json(
      rechecking
        ? { status: 'completed', ...(includeResult ? { result: null } : {}) }
        : { status: 'pending' },
    );
  });
  const stub = await setup('none');
  try {
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !!Object.values(await operations(stub))[0]?.remoteId);
    await stub.stopConversation();
    await waitUntil(async () => {
      const state = JSON.parse(await stub.snapshot());
      return !state.pending.length && !state.stopping;
    });
    const original = Object.values(await operations(stub))[0];
    rechecking = true;
    await stub.submitRun({
      runId: crypto.randomUUID(),
      text: 'recheck',
      source: remoteActionSource('recheck', original.taskId),
    });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect((await operations(stub))[original.taskId]).toMatchObject({
      status: original.status,
      remoteId: original.remoteId,
    });
    const messages = JSON.parse(await stub.snapshot()).entries.flatMap((e: any) => e.model ?? []);
    expect(messages.findLast((m: any) => m.toolName === 'example_recheck')).toMatchObject({
      isError: true,
    });
    expect(JSON.stringify(messages)).toContain('remote_response_invalid');

    includeResult = true;
    await stub.submitRun({
      runId: crypto.randomUUID(),
      text: 'recheck',
      source: remoteActionSource('recheck', original.taskId),
    });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect((await operations(stub))[original.taskId].status).toBe('completed');
    expect(submits).toBe(1);
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

it('committed progress reaches AG-UI state snapshots and restoration without leaking remote references', async () => {
  let submits = 0,
    queries = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      submits++;
      return Response.json({ id: 'server-private-job-id' });
    }
    queries++;
    return Response.json(
      queries < 2 ? { status: 'pending' } : { status: 'completed', result: { answer: 5 } },
    );
  });
  const stub = await setup('key');
  try {
    const runId = crypto.randomUUID();
    await stub.submitRun({ runId, text: 'slow remote example' });
    const text = await (await stub.observeRun(runId)).text();
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    const states = events.filter((e) => e.type === 'STATE_SNAPSHOT');
    expect(
      states.some((e) =>
        e.snapshot.extensionState['async-example'].some((o: any) => o.status === 'waiting'),
      ),
    ).toBe(true);
    expect(
      states.some((e) =>
        e.snapshot.extensionState['async-example'].some((o: any) => o.status === 'completed'),
      ),
    ).toBe(true);
    expect(states.every((e) => e.snapshot.runId === runId)).toBe(true);
    expect(JSON.stringify(states)).not.toContain('server-private-job-id');
    expect(JSON.stringify(states)).not.toContain('fingerprint');
    expect(await (await stub.observeRun(runId)).text()).toContain('RUN_FINISHED');
    expect(submits).toBe(1);
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

it('service reconfiguration never sends an old reference to a new endpoint', async () => {
  let redirected = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith('https://other.example.test')) redirected++;
    return Response.json(
      request.method === 'POST' ? { id: 'old-service-id' } : { status: 'pending' },
    );
  });
  let stub = await setup('key');
  try {
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !!Object.values(await operations(stub))[0]?.remoteId);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('ALTER TABLE test_remote ADD COLUMN endpoint TEXT');
      state.storage.sql.exec("UPDATE test_remote SET endpoint='https://other.example.test'");
    });
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    const original = Object.values(await operations(stub))[0];
    expect(original).toMatchObject({
      status: 'unknown',
      remoteId: 'old-service-id',
      service: 'https://async.example.test',
    });
    expect(redirected).toBe(0);
    expect(
      await stub.submitRun({
        runId: crypto.randomUUID(),
        text: 'recheck',
        source: remoteActionSource('recheck', original.taskId),
      }),
    ).toMatchObject({ error: { code: 'remote_configuration_changed' } });
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

it('ablation: removing the durable parent reference exposes duplicate submissions after reconstruction', async () => {
  let submits = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      submits++;
      return Response.json({ id: 'operation-' + submits });
    }
    return Response.json({ status: 'pending' });
  });
  let stub = await setup('key', 400);
  try {
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !!Object.values(await operations(stub))[0]?.remoteId);
    await runInDurableObject(stub, async (instance) => {
      const pi = await instance.harness.pi(),
        root = await instance.root();
      await pi.commit(async (tx) => {
        (await tx.doc(RemoteIntents, root.id)).operations = {};
      }, BG);
    });
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(submits).toBeGreaterThan(1);
    // Positive control in the first test retains the same reference and submits exactly once.
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

it('ablation: unsafe replay alone cannot stop a fresh model call when both host guards are removed', async () => {
  let submits = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    submits++;
    if (submits === 1) throw new Error('accepted without acknowledgement');
    return Response.json({ id: 'duplicate-side-effect' });
  });
  let stub = await setup('none');
  try {
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(Object.values(await operations(stub))[0].status).toBe('unknown');
    await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec('CREATE TABLE test_guardless (key TEXT)').toArray(),
    );
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example changed arguments' });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(submits).toBe(2);
    // Positive control above keeps the host checks and remains at one submit for the same new call.
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

it.each(['before-submit', 'completed-before-result', 'stop-marker'] as const)(
  'fault recovery at %s retains one remote operation',
  async (fault) => {
    let submits = 0,
      queries = 0,
      completed = false,
      cancels = 0;
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        submits++;
        return Response.json({ id: 'original' });
      }
      if (request.method === 'DELETE') {
        cancels++;
        return Response.json({ status: 'canceled' });
      }
      queries++;
      if (fault === 'completed-before-result' && queries === 1) {
        completed = true;
        await new Promise<void>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('lost result')), 2000);
          request.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('evicted'));
            },
            { once: true },
          );
        });
      }
      return Response.json(
        fault === 'stop-marker'
          ? { status: 'pending' }
          : { status: 'completed', result: { originalResult: 7 } },
      );
    });
    let stub = await setup('key');
    try {
      await stub.submitRun({
        runId: crypto.randomUUID(),
        text: fault === 'before-submit' ? 'slow remote example' : 'remote example',
      });
      if (fault === 'before-submit') expect(submits).toBe(0);
      if (fault === 'completed-before-result') await waitUntil(async () => completed);
      if (fault === 'stop-marker') {
        await waitUntil(async () => !!Object.values(await operations(stub))[0]?.remoteId);
        await stub.submitRun({ runId: crypto.randomUUID(), text: 'queued must withdraw' });
        await runInDurableObject(stub, async (instance) => {
          const root = await instance.root();
          await root.commit(async (tx) => {
            (await tx.doc(ConversationControl, root.id)).stopping = true;
          }, BG);
        });
      }
      await abortAllDurableObjects();
      stub = env.CONVERSATIONS.get(stub.id);
      await waitUntil(async () => {
        const s = JSON.parse(await stub.snapshot());
        return !s.pending.length && !s.stopping;
      });
      expect(submits).toBe(1);
      const snapshot = JSON.parse(await stub.snapshot());
      if (fault === 'stop-marker') {
        expect(cancels).toBe(1);
        expect(Object.values(await operations(stub))[0]).toMatchObject({
          status: 'canceled',
          remoteStatus: 'canceled',
        });
        expect(JSON.stringify(snapshot.entries)).not.toContain('queued must withdraw');
      } else {
        expect(
          snapshot.entries
            .flatMap((e: any) => e.model ?? [])
            .filter((m: any) => m.role === 'toolResult' && m.toolName === 'example_generate'),
        ).toHaveLength(1);
        expect(JSON.stringify(snapshot.entries)).toContain('originalResult');
      }
    } finally {
      await abortAllDurableObjects();
      network.mockRestore();
    }
  },
);

it('disabling and re-enabling the example preserves an interrupted outcome and never silently resubmits', async () => {
  let submits = 0;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      submits++;
      return Response.json({ id: 'original' });
    }
    return Response.json({ status: 'pending' });
  });
  let stub = await setup('key');
  try {
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example' });
    await waitUntil(async () => !!Object.values(await operations(stub))[0]?.remoteId);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('CREATE TABLE test_extensions (id TEXT PRIMARY KEY, enabled INTEGER)');
      state.storage.sql.exec("INSERT INTO test_extensions VALUES('async-example',0)");
    });
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(JSON.parse(await stub.snapshot()).extensionState['async-example']).toBeUndefined();
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec('UPDATE test_extensions SET enabled=1');
    });
    await abortAllDurableObjects();
    stub = env.CONVERSATIONS.get(stub.id);
    expect(JSON.parse(await stub.snapshot()).extensionState['async-example']).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'unknown' })]),
    );
    await stub.submitRun({ runId: crypto.randomUUID(), text: 'remote example changed arguments' });
    await waitUntil(async () => !JSON.parse(await stub.snapshot()).pending.length);
    expect(submits).toBe(1);
    expect(Object.values(await operations(stub))[0]?.status).toBe('unknown');
  } finally {
    await abortAllDurableObjects();
    network.mockRestore();
  }
});

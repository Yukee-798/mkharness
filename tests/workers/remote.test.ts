import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { RemoteIntents, type RemoteIntent } from '../../src/server/remote-example';
import { BG } from '../../src/server/conversation';

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
it.each(['key', 'none'] as const)(
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
      expect(op.status).toBe(mode === 'key' ? 'completed' : 'unknown');
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

import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { Harness } from '@earendil-works/pi-durable';
import { BG } from '../../src/server/conversation';
import type { LifecycleProbe } from './lifecycle-entry';

const probes = (env as unknown as { LIFECYCLE_PROBES: DurableObjectNamespace<LifecycleProbe> })
  .LIFECYCLE_PROBES;
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
type Snapshot = {
  entries: { model?: { role: string; toolName?: string; content: unknown }[] }[];
  pending: unknown[];
  stopping: boolean;
  runtimeIssues: unknown[];
};
async function settle(stub: DurableObjectStub<LifecycleProbe>): Promise<Snapshot> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const snapshot: Snapshot = JSON.parse(await stub.snapshot());
    if (!snapshot.pending.length && !snapshot.stopping && !(await stub.needsRecovery()))
      return snapshot;
    await pause();
  }
  throw new Error('Lifecycle recovery did not settle');
}
const messages = (snapshot: Snapshot) => snapshot.entries.flatMap((entry) => entry.model ?? []);

it('restores completed history in a new DO without executing successful tools again', async () => {
  let stub = probes.getByName(crypto.randomUUID());
  const command = { runId: crypto.randomUUID(), text: 'skill activation' };
  await stub.submitRun(command);
  const before = await settle(stub);
  const old = await stub.probe();
  expect(old.counts).toEqual([
    { name: 'activate_skill', n: 1 },
    { name: 'read_skill_resource', n: 1 },
  ]);
  await abortAllDurableObjects();
  stub = probes.get(stub.id);
  expect((await settle(stub)).entries).toEqual(before.entries);
  const fresh = await stub.probe();
  expect(fresh.instanceId).not.toBe(old.instanceId);
  expect(fresh.opens).toBe(1);
  expect(fresh.counts).toEqual(old.counts);
  expect(await stub.submitRun(command)).toMatchObject({ accepted: true });
  expect(messages(await settle(stub)).filter((message) => message.role === 'user')).toHaveLength(1);
  expect((await stub.probe()).requests).toHaveLength(1);
});

it('resumes a pending safe tool and its queue after actual DO reconstruction', async () => {
  let stub = probes.getByName(crypto.randomUUID());
  const first = { runId: crypto.randomUUID(), text: 'progress seam' };
  await stub.submitRun(first);
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await stub.probe()).counts.some((row) => row.name === 'progress:1')) break;
    await pause();
  }
  const old = await stub.probe();
  expect(old.counts).toEqual([
    { name: 'progress:0', n: 1 },
    { name: 'progress:1', n: 1 },
  ]);
  const queued = { runId: crypto.randomUUID(), text: 'queued following recovery' };
  await stub.submitRun(queued);
  await abortAllDurableObjects();
  stub = probes.get(stub.id);
  expect(await stub.submitRun(first)).toMatchObject({ accepted: true });
  expect(await stub.submitRun(queued)).toMatchObject({ accepted: true });
  const snapshot = await settle(stub);
  const fresh = await stub.probe();
  expect(fresh.instanceId).not.toBe(old.instanceId);
  expect(fresh.opens).toBe(1);
  expect(fresh.counts).toEqual([
    { name: 'progress:0', n: 1 },
    { name: 'progress:1', n: 2 },
  ]);
  expect(fresh.requests).toHaveLength(2);
  expect(
    messages(snapshot)
      .filter((message) => message.role === 'user')
      .map((message) => message.content),
  ).toEqual([first.text, queued.text]);
  expect(
    messages(snapshot).filter((message) => message.toolName === 'progress_probe'),
  ).toHaveLength(2);
  expect(snapshot.runtimeIssues).toEqual([]);
});

it('joins application deletion before closing and deleting real storage once', async () => {
  const id = crypto.randomUUID();
  const stub = probes.getByName(id);
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS lifecycle_delete(seq INTEGER PRIMARY KEY AUTOINCREMENT,chat TEXT,phase TEXT,closed INTEGER)',
  );
  const owner = crypto.randomUUID(),
    now = Date.now();
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,isAnonymous)VALUES(?,?,?,0,?,?,1)',
  )
    .bind(owner, 'guest', owner + '@test.invalid', now, now)
    .run();
  await env.DB.prepare(
    'INSERT INTO conversations(id,owner,title,created_at,updated_at)VALUES(?,?,?,?,?)',
  )
    .bind(id, owner, 'deletion', now, now)
    .run();
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'ignores_cancel' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (JSON.parse(await stub.snapshot()).tools.length) break;
    await pause();
  }
  expect(JSON.parse(await stub.snapshot()).tools).toHaveLength(1);
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'queued must not finish' });
  await runInDurableObject(stub, async (instance, state) => {
    const pi = await instance.harness.pi();
    const close = pi.close.bind(pi);
    let closed = false;
    pi.close = async (context) => {
      await close(context);
      closed = true;
      await env.DB.prepare("INSERT INTO lifecycle_delete(chat,phase,closed)VALUES(?,'close',1)")
        .bind(id)
        .run();
    };
    const deleteAll = state.storage.deleteAll.bind(state.storage);
    state.storage.deleteAll = async () => {
      await env.DB.prepare("INSERT INTO lifecycle_delete(chat,phase,closed)VALUES(?,'delete',?)")
        .bind(id, closed ? 1 : 0)
        .run();
      await deleteAll();
      const remaining = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name='app_requests'")
        .toArray().length;
      await env.DB.prepare("INSERT INTO lifecycle_delete(chat,phase,closed)VALUES(?,'remaining',?)")
        .bind(id, remaining)
        .run();
    };
  });
  // Native destroy aborts the old isolate; observe its facts in independent test D1.
  await Promise.allSettled([stub.deleteConversation(id), stub.deleteConversation(id)]);
  expect(
    (await env.DB.prepare('SELECT id FROM conversations WHERE id=?').bind(id).all()).results,
  ).toEqual([]);
  expect(
    (
      await env.DB.prepare('SELECT phase,closed FROM lifecycle_delete WHERE chat=? ORDER BY seq')
        .bind(id)
        .all()
    ).results,
  ).toEqual([
    { phase: 'close', closed: 1 },
    { phase: 'delete', closed: 1 },
    { phase: 'remaining', closed: 0 },
  ]);
});

it('releases a failed native Session only after close and reopens from the same SQLite', async () => {
  const stub = probes.getByName(crypto.randomUUID());
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'skill activation' });
  const before = await settle(stub);
  await runInDurableObject(stub, async (instance) => {
    const pi = await instance.harness.pi();
    const storage = await instance.harness.storage();
    const read = vi
      .spyOn(storage, 'scanConversations')
      .mockRejectedValueOnce(new Error('fixture storage failure'));
    await expect(pi.commit((tx) => tx.scanConversations({}, 1), {} as any)).rejects.toThrow(
      'fixture storage failure',
    );
    expect(await pi.closed).toMatchObject({ reason: 'failed' });
    await expect(pi.commit((tx) => tx.scanConversations({}, 1), {} as any)).rejects.toMatchObject({
      name: 'SessionFailed',
    });
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRestore();
    await pause();
    expect(instance.probe().opens).toBe(1); // Invalidation must not eagerly reconstruct.
    // PiHarness releases only the adopted failed handle after native close.
    for (let i = 0; i < 100 && instance.probe().opens === 1; i++) {
      await instance.root();
      await pause();
    }
    const restored = await instance.harness.pi();
    expect(restored).not.toBe(pi);
    expect(instance.probe().opens).toBe(2);
    expect(JSON.parse(await instance.snapshot()).entries).toEqual(before.entries);
    expect(instance.probe().counts).toEqual([
      { name: 'activate_skill', n: 1 },
      { name: 'read_skill_resource', n: 1 },
    ]);
  });
});

it('does not release an opening handle when its Session fails before factory adoption', async () => {
  const stub = probes.getByName(crypto.randomUUID());
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'skill activation' });
  await settle(stub);
  await runInDurableObject(stub, async (instance) => {
    await instance.harness.dispose();
    let reportFailure!: () => void, finishFactory!: () => void;
    const failed = new Promise<void>((resolve) => (reportFailure = resolve));
    const barrier = new Promise<void>((resolve) => (finishFactory = resolve));
    const open = Harness.open.bind(Harness);
    const opening = vi.spyOn(Harness, 'open').mockImplementationOnce(async (...args) => {
      const pi = await open(...args);
      const conversation = pi.conversation.bind(pi);
      pi.conversation = async (...input) => {
        pi.conversation = conversation;
        const read = vi
          .spyOn(args[0], 'scanConversations')
          .mockRejectedValueOnce(new Error('fixture initialization failure'));
        try {
          await pi.commit((tx) => tx.scanConversations({}, 1), BG);
        } catch (error) {
          await pi.closed;
          read.mockRestore();
          reportFailure();
          await barrier;
          throw error;
        }
        return conversation(...input);
      };
      return pi;
    });
    const first = instance.harness.pi().catch((error: Error) => error);
    await failed;
    const second = instance.harness.pi().catch((error: Error) => error);
    try {
      await pause();
      expect(instance.probe().opens).toBe(2);
    } finally {
      finishFactory();
      await Promise.all([first, second]);
      opening.mockRestore();
    }
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    expect(instance.probe().opens).toBe(2);
    const replacement = await instance.harness.pi();
    expect(await instance.harness.pi()).toBe(replacement);
    expect(instance.probe().opens).toBe(3);
  });
});

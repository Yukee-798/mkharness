import { abortAllDurableObjects } from 'cloudflare:test';
import { env } from './env';
import { expect, it } from 'vitest';

const probes = env.LIFECYCLE_PROBES;
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
type Snapshot = {
  entries: { model?: { role: string; toolName?: string; content: unknown }[] }[];
  pending: unknown[];
  stopping: boolean;
  runtimeIssues: unknown[];
};
async function settle(stub: ReturnType<typeof probes.getByName>): Promise<Snapshot> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const snapshot: Snapshot = JSON.parse(await stub.snapshot());
    if (!snapshot.pending.length && !snapshot.stopping) return snapshot;
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

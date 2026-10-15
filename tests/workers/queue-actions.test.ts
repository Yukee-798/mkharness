import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { BG } from '../../src/server/conversation';
import type { SubmissionRecord } from '@earendil-works/pi-durable';
import { InboxDoc } from '@earendil-works/pi-durable';
const command = (text: string) => ({ runId: crypto.randomUUID(), text });
const receipt = async (stub: any, id: string): Promise<SubmissionRecord> =>
  (await stub.submission(id))!;
async function settled(
  stub: ReturnType<typeof env.CONVERSATIONS.getByName>,
  id: string,
): Promise<SubmissionRecord> {
  return JSON.parse(
    await runInDurableObject(stub, async (instance): Promise<string> => {
      const record = await instance.submission(id);
      if (!record) throw new Error('Missing native submission');
      const submission = await (await instance.harness.pi()).submission(record.id, BG);
      if (!submission) throw new Error('Missing native handle');
      return JSON.stringify(await submission.wait(BG));
    }),
  );
}
const act = async (stub: any, id: string, action: string) =>
  JSON.parse(await stub.actOnQueuedInput(id, action));

it('projects native queued content, restores after eviction and withdraws only the selected input', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const first = command('slow first'),
    b = command('remove this'),
    c = command('keep this');
  await stub.submitRun(first);
  await stub.submitRun(b);
  await stub.submitRun(c);
  const before: import('../../src/shared/queue').QueuedInput[] = await (stub as any).queuedInputs();
  expect(before).toEqual([
    { ...b, mode: 'followUp' },
    { ...c, mode: 'followUp' },
  ]);
  const beforeRecord = await receipt(stub, b.runId);
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(JSON.parse(await stub.snapshot()).queue).toEqual(before);
  expect(await act(stub, b.runId, 'remove')).toMatchObject({ queue: [{ ...c, mode: 'followUp' }] });
  expect(await receipt(stub, b.runId)).toMatchObject({
    id: beforeRecord.id,
    status: 'unanswered',
    reason: 'aborted',
  });
  expect((await receipt(stub, first.runId)).status).not.toBe('unanswered');
  expect(await act(stub, b.runId, 'remove')).toMatchObject({ queue: [{ ...c, mode: 'followUp' }] });
  expect(await stub.submitRun(b)).toMatchObject({ error: { code: 'request_withdrawn' } });
  expect(await settled(stub, c.runId)).toMatchObject({ status: 'done' });
  expect(JSON.stringify(JSON.parse(await stub.snapshot()).entries)).not.toContain(b.text);
});

it('edit returns the original bounded draft and a new run ID executes it exactly once', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun(command('slow first'));
  const original = {
    ...command('edit me'),
    config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' as const },
  };
  await stub.submitRun(original);
  const response = await act(stub, original.runId, 'edit');
  expect(response.draft).toEqual({ text: original.text, config: original.config });
  expect(await act(stub, original.runId, 'edit')).toEqual(response);
  expect(JSON.stringify(response)).not.toMatch(/credentialRef|apiKey|fingerprint/);
  const edited = { ...command('edited message'), config: original.config };
  await stub.submitRun(edited);
  await stub.submitRun(edited);
  expect(await settled(stub, edited.runId)).toMatchObject({ status: 'done' });
  const users = JSON.parse(await stub.snapshot())
    .entries.flatMap((e: any) => e.model ?? [])
    .filter((m: any) => m.role === 'user');
  expect(users.filter((m: any) => m.content === edited.text)).toHaveLength(1);
  expect(users.some((m: any) => m.content === original.text)).toBe(false);
});

it('steer changes only the native lane, joins the running answer at a tool boundary and preserves other followers', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const first = command('progress seam'),
    b = command('steered direction'),
    c = command('later follower');
  await stub.submitRun(first);
  await expect.poll(async () => JSON.parse(await stub.snapshot()).tools.length).toBeGreaterThan(0);
  await stub.submitRun(c);
  await stub.submitRun(b);
  const id = (await receipt(stub, b.runId)).id;
  const saved = await runInDurableObject(
    stub,
    (_, state) =>
      state.storage.sql.exec('SELECT payload FROM app_requests WHERE id=?', b.runId).one().payload,
  );
  const observation = await stub.observeRun(first.runId);
  const stream = observation.text();
  const result = await act(stub, b.runId, 'steer');
  expect(result.queue[0].runId).toBe(b.runId);
  expect(result.queue.find((item: any) => item.runId === b.runId)).toMatchObject({ mode: 'steer' });
  expect((await receipt(stub, b.runId)).id).toBe(id);
  expect(
    await runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql.exec('SELECT payload FROM app_requests WHERE id=?', b.runId).one()
          .payload,
    ),
  ).toBe(saved);
  const inbox = JSON.parse(
    await runInDurableObject(
      stub as ReturnType<typeof env.CONVERSATIONS.getByName>,
      async (instance): Promise<string> =>
        JSON.stringify(
          await (
            await (instance as any).harness.pi()
          ).snapshot(InboxDoc, (await instance.root()).id, BG),
        ),
    ),
  );
  expect(inbox.items.find((item: any) => item.id === id).mode).toBe('steer');
  expect(await settled(stub, b.runId)).toMatchObject({ status: 'done' });
  expect((await receipt(stub, b.runId)).answer).toBe((await receipt(stub, first.runId)).answer);
  expect(await settled(stub, c.runId)).toMatchObject({ status: 'done' });
  expect((await receipt(stub, c.runId)).answer).not.toBe((await receipt(stub, first.runId)).answer);
  const states = (await stream)
    .split('\n\n')
    .filter((line: string) => line.startsWith('data: '))
    .map((line: string) => JSON.parse(line.slice(6)))
    .filter((event: any) => event.type === 'STATE_SNAPSHOT' && event.snapshot.queue !== undefined);
  expect(
    states.some((event: any) =>
      event.snapshot.queue.some((item: any) => item.runId === b.runId && item.mode === 'steer'),
    ),
  ).toBe(true);
  expect(states.at(-1).snapshot.queue.some((item: any) => item.runId === b.runId)).toBe(false);
});

it.each(['edit', 'steer', 'remove'])(
  'rejects %s once placement wins without aborting the running task',
  async (action) => {
    const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    const first = command('slow first');
    await stub.submitRun(first);
    const record = await receipt(stub, first.runId);
    expect(['placed', 'done']).toContain(record.status);
    expect(await act(stub, first.runId, action)).toMatchObject({
      error: { status: 409, code: 'queue_item_started' },
    });
    expect((await receipt(stub, first.runId))?.status).not.toBe('unanswered');
    expect(await settled(stub, first.runId)).toMatchObject({ status: 'done' });
  },
);

it('does not disclose or mutate a run from another conversation and rejects actions during stop', async () => {
  const a = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const b = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const input = command('slow other conversation');
  await a.submitRun(input);
  expect(await act(b, input.runId, 'edit')).toMatchObject({ error: { code: 'run_not_found' } });
  expect(await act(a, input.runId, 'invalid')).toMatchObject({
    error: { code: 'invalid_request' },
  });
  await a.stopConversation();
  expect(await act(a, input.runId, 'edit')).toMatchObject({ error: { code: 'stopping' } });
});

it.each(['edit', 'remove'])(
  'native withdrawal rejects a stale queued read when placement wins (%s)',
  async (action) => {
    const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
    const first = command('slow first'),
      follower = command('slow follower');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await runInDurableObject(stub, (instance): void => {
      const probe = instance as any;
      const original = probe.credentials.bind(instance);
      let first = true;
      probe.credentials = async () => {
        const access = await original();
        return {
          select: access.select.bind(access),
          resolve: async (...args: any[]) => {
            if (first) {
              first = false;
              await gate;
            }
            return access.resolve(...args);
          },
        };
      };
    });
    await stub.submitRun(first);
    await stub.submitRun(follower);
    await runInDurableObject(stub, async (instance): Promise<void> => {
      const probe = instance as any;
      const original = probe.submission.bind(instance);
      const pi = await probe.harness.pi();
      const followerRecord = await original(follower.runId);
      const handle = await pi.submission(followerRecord.id, BG);
      probe.submission = async (id: string) => {
        const stale = await original(id);
        if (id === follower.runId) {
          expect(stale.status).toBe('queued');
          release();
          await handle.wait(BG);
        }
        return stale;
      };
      try {
        expect(JSON.parse(await probe.actOnQueuedInput(follower.runId, action))).toMatchObject({
          error: { code: 'queue_item_started' },
        });
        expect(['placed', 'done']).toContain((await handle.status(BG)).status);
      } finally {
        delete probe.submission;
      }
    });
    expect(await settled(stub, follower.runId)).toMatchObject({ status: 'done' });
  },
);

it('reconciles a native withdrawal committed before the host flag without accepting or replaying it', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun(command('slow first'));
  const follower = command('never replay withdrawn');
  await stub.submitRun(follower);
  await runInDurableObject(stub, async (instance): Promise<void> => {
    const probe = instance as any;
    const native = await probe.submission(follower.runId);
    expect(
      await (await probe.harness.pi()).abortSubmission(native.id, BG, (await instance.root()).id),
    ).toBe('aborted');
    // Deliberately leave accepted=1: simulate isolate loss between the two stores.
  });
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  expect(await stub.submitRun(follower)).toMatchObject({ error: { code: 'request_withdrawn' } });
  expect(JSON.stringify(JSON.parse(await stub.snapshot()).entries)).not.toContain(follower.text);
});

it('queue edit preserves image bytes and source payload while excluding server execution metadata', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const image = {
    name: 'pixel.png',
    mimeType: 'image/png' as const,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlp0AAAAASUVORK5CYII=',
  };
  await runInDurableObject(stub, async (instance): Promise<void> => {
    const probe = instance as any;
    const base = await probe.contributions();
    probe.contributions = async () => [
      ...base,
      { id: 'queue-test', actions: { continue: { normalize: async (payload: any) => payload } } },
    ];
  });
  await stub.submitRun(command('slow first'));
  const input = {
    ...command('image draft'),
    images: [image],
    config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' as const },
    source: {
      action: 'extension_action' as const,
      extensionId: 'queue-test',
      name: 'continue',
      payload: { choice: 'A' },
    },
  };
  await stub.submitRun(input);
  expect((await stub.queuedInputs())[0]).toEqual({
    runId: input.runId,
    text: input.text,
    images: [image],
    mode: 'followUp',
  });
  const result = await act(stub, input.runId, 'edit');
  expect(result.draft).toEqual({
    text: input.text,
    images: [image],
    config: input.config,
    source: input.source,
  });
  expect(JSON.stringify(result)).not.toMatch(/credentialRef|sourceContext|apiKey/);
});

it('bounds queue previews without trimming the editable original or writing projection state', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await runInDurableObject(stub, (instance): void => {
    const probe = instance as any;
    const original = probe.credentials.bind(instance);
    let first = true;
    probe.credentials = async () => {
      const access = await original();
      return {
        select: access.select.bind(access),
        resolve: async (...args: any[]) => {
          if (first) {
            first = false;
            await gate;
          }
          return access.resolve(...args);
        },
      };
    };
  });
  try {
    await stub.submitRun(command('first held provider'));
    const bytes = new Uint8Array(100000);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const image = {
      name: 'large.png',
      mimeType: 'image/png' as const,
      data: btoa(String.fromCharCode(...bytes)),
    };
    const input = {
      ...command('large preview'),
      images: [image],
      config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' as const },
    };
    await stub.submitRun(input);
    const metadata = () =>
      runInDurableObject(stub, (_, state): string =>
        JSON.stringify(state.storage.sql.exec('SELECT * FROM pi_durable_metadata').toArray()),
      );
    const before = await metadata();
    const queue = await stub.queuedInputs();
    expect(queue).toEqual([
      {
        runId: input.runId,
        text: input.text,
        mode: 'followUp',
        images: [{ name: image.name, mimeType: image.mimeType }],
      },
    ]);
    expect(await metadata()).toBe(before);
    expect((await act(stub, input.runId, 'edit')).draft.images).toEqual([image]);
  } finally {
    release();
  }
});

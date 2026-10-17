import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { expect, it } from 'vitest';
import { fixtureModels } from '../fixture-model';
import { withdrawFailedFollowers } from '../../src/server/chat/admission-recovery';
const context = { abortSignal: undefined, value: () => undefined, toString: () => '[test]' };

it('native negative control stays queued; recovery withdraws without replay and keeps a live queue', async () => {
  const models = fixtureModels(),
    provider = models.getProvider('fixture')!;
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  models.setProvider({
    ...provider,
    auth: {
      apiKey: {
        name: 'test',
        resolve: async () => {
          entered = true;
          await gate;
          throw new Error('credential unavailable');
        },
      },
    },
  });
  const pi = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    context,
  );
  try {
    const root = await pi.root(context, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    const a = await root.submit({ type: 'input', requestId: 'A', content: 'first' }, context);
    await expect.poll(() => entered).toBe(true);
    const b = await root.submit(
      { type: 'input', requestId: 'B', content: 'follower', whenBusy: 'followUp' },
      context,
    );
    await withdrawFailedFollowers(pi, root.id, context);
    expect((await b.status(context)).status).toBe('queued');
    release();
    expect(await a.wait(context)).toMatchObject({ status: 'unanswered', reason: 'model_error' });
    // Ablation: enabling native scheduling alone does not settle or execute the follower.
    pi.resume();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await pi.inspect(context)).tasks).toEqual([]);
    expect((await b.status(context)).status).toBe('queued');
    await withdrawFailedFollowers(pi, root.id, context);
    expect(await b.wait(context)).toMatchObject({ status: 'unanswered', reason: 'aborted' });
    expect(JSON.stringify((await root.entries({}, 100, undefined, context)).items)).not.toContain(
      'follower',
    );
  } finally {
    release();
    await pi.close(context);
  }
});

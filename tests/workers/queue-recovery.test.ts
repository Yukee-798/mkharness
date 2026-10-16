import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { AppError } from '../../src/shared/contracts';
import type { CredentialAccess } from '../../src/server/models/execution';

it.each([false, true])(
  'withdraws an unexecuted follower after model failure (reconstruct=%s)',
  async (reconstruct) => {
    let stub: any = env.CONVERSATIONS.getByName(crypto.randomUUID());
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await runInDurableObject(stub, (instance) => {
      const probe = instance as unknown as {
        credentials(): Promise<CredentialAccess>;
        reconcile(): Promise<void>;
      };
      const original = probe.credentials.bind(instance);
      let first = true;
      probe.credentials = async () => {
        const access = await original();
        return {
          select: access.select.bind(access),
          resolve: async (...args: Parameters<typeof access.resolve>) => {
            if (!first) return access.resolve(...args);
            first = false;
            entered = true;
            await gate;
            throw new AppError(
              503,
              'credential_unavailable',
              '原请求的个人凭据已撤销或过期，请发起新请求',
            );
          },
        };
      };
      // Preserve the native failed-run/queued-input gap until actual eviction.
      if (reconstruct) probe.reconcile = async () => {};
    });
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    try {
      await stub.submitRun({ runId: a, text: 'first credential fails' });
      await expect.poll(() => entered).toBe(true);
      await stub.submitRun({ runId: b, text: 'must not remain waiting or run automatically' });
      release();
      await expect.poll(async () => (await stub.submission(a))?.status).toBe('unanswered');
      if (reconstruct) {
        expect((await stub.submission(b))?.status).toBe('queued');
        await abortAllDurableObjects();
        stub = env.CONVERSATIONS.get(stub.id);
        await stub.snapshot();
      }
      await expect.poll(async () => (await stub.submission(b))?.status).toBe('unanswered');
      expect(await stub.submission(b)).toMatchObject({ reason: 'aborted' });
      const snapshot = JSON.parse(await stub.snapshot());
      expect(snapshot.pending).toEqual([]);
      expect(JSON.stringify(snapshot.entries)).not.toContain('must not remain waiting');
      const body = await (await stub.observeRun(b)).text();
      expect(body).toContain('RUN_ERROR');
      expect(body).not.toContain('RUN_FINISHED');
      // A real new user operation can run after the failed queue was withdrawn.
      const next = crypto.randomUUID();
      await stub.submitRun({ runId: next, text: 'new operation after failure' });
      await expect.poll(async () => (await stub.submission(next))?.status).toBe('done');
    } finally {
      release();
    }
  },
);

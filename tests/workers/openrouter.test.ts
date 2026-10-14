import { env, runInDurableObject, abortAllDurableObjects } from 'cloudflare:test';
import { expect, it } from 'vitest';
it(
  'runs native OpenRouter tools and OpenUI through production SSE without a personal key and restores history',
  { timeout: 45000 },
  async () => {
    const owner = crypto.randomUUID(),
      chat = crypto.randomUUID(),
      runId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,?,?,?)',
    )
      .bind(owner, 'Free demo', owner + '@example.test', 0, Date.now(), Date.now())
      .run();
    await env.DB.prepare(
      'INSERT INTO conversations(id,owner,title,created_at,updated_at)VALUES(?,?,?,?,?)',
    )
      .bind(chat, owner, 'Free demo', Date.now(), Date.now())
      .run();
    const namespace = (env as any).OPENROUTER_PROBES as DurableObjectNamespace<
      import('./openrouter-entry').OpenRouterProbe
    >;
    let stub = namespace.getByName(chat);
    expect(await stub.submitRun({ runId, text: 'count and show UI' })).toMatchObject({
      accepted: true,
    });
    const body = await runInDurableObject(stub, async (instance) =>
      (await instance.observeRun(runId)).text(),
    );
    const events = body
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)));
    expect(events.at(-1).type).toBe('RUN_FINISHED');
    const snapshot = JSON.parse(await stub.snapshot());
    const results = snapshot.entries
      .flatMap((e: any) => e.model ?? [])
      .filter((m: any) => m.role === 'toolResult');
    expect(results.map((m: any) => m.toolName)).toEqual(['describe_text', 'present_openui']);
    expect(results.every((m: any) => !m.isError)).toBe(true);
    const calls = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT model FROM test_openrouter_requests').toArray(),
    );
    expect(calls).toEqual([{ model: 'openrouter/free' }, { model: 'openrouter/free' }]);
    await abortAllDurableObjects();
    stub = namespace.get(stub.id);
    expect(JSON.parse(await stub.snapshot()).entries).toEqual(snapshot.entries);
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql.exec('SELECT COUNT(*) AS n FROM test_openrouter_requests').one().n,
      ),
    ).toBe(2);
  },
);

it('rejects paid deployment calls and settles exhausted free quota without replay after restart', async () => {
  const owner = crypto.randomUUID(),
    chat = crypto.randomUUID(),
    runId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,?,?,?)',
  )
    .bind(owner, 'Quota demo', owner + '@example.test', 0, Date.now(), Date.now())
    .run();
  await env.DB.prepare(
    'INSERT INTO conversations(id,owner,title,created_at,updated_at)VALUES(?,?,?,?,?)',
  )
    .bind(chat, owner, 'Quota demo', Date.now(), Date.now())
    .run();
  const namespace = (env as any).OPENROUTER_PROBES as DurableObjectNamespace<
    import('./openrouter-entry').OpenRouterProbe
  >;
  let stub = namespace.getByName(chat);
  expect(
    await stub.submitRun({
      runId: crypto.randomUUID(),
      text: 'paid attempt',
      config: { provider: 'openrouter', modelId: 'openai/gpt-5-mini', thinkingLevel: 'low' },
    }),
  ).toMatchObject({ error: { code: 'model_not_allowed' } });
  expect(await stub.submitRun({ runId, text: 'quota fixture' })).toMatchObject({ accepted: true });
  await runInDurableObject(stub, async (instance) => (await instance.observeRun(runId)).text());
  const snapshot = JSON.parse(await stub.snapshot());
  expect(snapshot.pending).toHaveLength(0);
  expect(JSON.stringify(snapshot.entries)).toContain('免费模型额度');
  await abortAllDurableObjects();
  stub = namespace.get(stub.id);
  expect(JSON.parse(await stub.snapshot()).pending).toHaveLength(0);
  expect(
    await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql.exec('SELECT COUNT(*) AS n FROM test_openrouter_requests').one().n,
    ),
  ).toBe(1);
});

import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ModelCredentials } from '../../src/server/model-credentials';
const master = btoa('x'.repeat(32));
const canary = 'personal-canary-never-public';
async function owner() {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)',
  )
    .bind(id, 'fixture', id + '@example.test', Date.now(), Date.now())
    .run();
  return id;
}
const configured = () => ({
  ...env,
  CREDENTIAL_ENCRYPTION_KEY: master,
  ALLOW_SERVER_MODEL_KEY: '1',
  MODEL_PROVIDER: 'openai',
  MODEL_ID: 'gpt-5-mini',
  MODEL_API_KEY: 'deployment-canary',
});

it('stores authenticated ciphertext while metadata and other owners cannot expose the key', async () => {
  const id = await owner(),
    other = await owner();
  const store = new ModelCredentials(configured(), id);
  const metadata = await store.save('openai', {
    apiKey: '  ' + canary + '  ',
    expectedCurrentId: null,
  });
  expect(metadata).toMatchObject({ provider: 'openai', configured: true, effectiveSource: 'user' });
  expect(JSON.stringify(metadata)).not.toContain(canary);
  const rows = await env.DB.prepare('SELECT * FROM model_credentials WHERE owner=?').bind(id).all();
  expect(JSON.stringify(rows.results)).not.toContain(canary);
  expect(rows.results[0].nonce).toBeTruthy();
  const reference = await store.select('openai', 'gpt-5-mini');
  expect(await store.resolve('openai', reference)).toEqual({ apiKey: canary });
  await expect(
    new ModelCredentials(configured(), other).resolve('openai', reference),
  ).rejects.toMatchObject({ code: 'credential_unavailable' });
  await expect(store.resolve('anthropic', reference)).rejects.toMatchObject({
    code: 'credential_unavailable',
  });
});

it('atomically arbitrates competing replacements and retains the accepted old version', async () => {
  const id = await owner(),
    store = new ModelCredentials(configured(), id);
  const first = await store.save('openai', { apiKey: canary, expectedCurrentId: null });
  const reference = await store.select('openai', 'gpt-5-mini');
  const competing = await Promise.allSettled(
    ['next-a', 'next-b'].map((apiKey) =>
      store.save('openai', { apiKey, expectedCurrentId: first.currentId }),
    ),
  );
  expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(competing.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { code: 'credential_conflict' },
  });
  expect(await store.resolve('openai', reference)).toEqual({ apiKey: canary });
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM model_credentials WHERE owner=?')
      .bind(id)
      .first('n'),
  ).toBe(2);
  await expect(
    store.save('openai', { apiKey: 'lost-receipt-retry', expectedCurrentId: first.currentId }),
  ).rejects.toMatchObject({ code: 'credential_conflict' });
});

it('rejects altered AAD, bad master keys, and invalid plaintext without falling back', async () => {
  const id = await owner(),
    store = new ModelCredentials(configured(), id);
  await store.save('openai', { apiKey: canary, expectedCurrentId: null });
  const reference = await store.select('openai', 'gpt-5-mini');
  await expect(
    new ModelCredentials(
      { ...configured(), CREDENTIAL_ENCRYPTION_KEY: btoa('z'.repeat(32)) },
      id,
    ).resolve('openai', reference),
  ).rejects.toMatchObject({ code: 'credential_decryption_failed' });
  await store.save('anthropic', { apiKey: 'second-provider', expectedCurrentId: null });
  const second = await store.select('anthropic', 'claude-sonnet-4-5');
  await env.DB.prepare(
    "UPDATE model_credentials SET ciphertext=(SELECT ciphertext FROM model_credentials WHERE owner=? AND provider='openai'),nonce=(SELECT nonce FROM model_credentials WHERE owner=? AND provider='openai') WHERE owner=? AND provider='anthropic'",
  )
    .bind(id, id, id)
    .run();
  await expect(store.resolve('anthropic', second)).rejects.toMatchObject({
    code: 'credential_decryption_failed',
  });
  await env.DB.prepare('UPDATE model_credentials SET nonce=? WHERE owner=?')
    .bind(btoa('y'.repeat(12)), id)
    .run();
  await expect(store.resolve('openai', reference)).rejects.toMatchObject({
    code: 'credential_decryption_failed',
  });
  for (const apiKey of ['', 'a\nb', '汉'.repeat(3000)])
    await expect(
      store.save('anthropic', { apiKey, expectedCurrentId: null }),
    ).rejects.toMatchObject({ code: 'invalid_api_key' });
  await expect(
    new ModelCredentials({ ...configured(), CREDENTIAL_ENCRYPTION_KEY: '' }, id).save('anthropic', {
      apiKey: canary,
      expectedCurrentId: null,
    }),
  ).rejects.toMatchObject({ code: 'credential_storage_not_configured' });
});

it('expires retired references at the absolute deadline without writes on reads', async () => {
  const id = await owner();
  let time = 1000;
  const store = new ModelCredentials(configured(), id, () => time);
  const first = await store.save('openai', { apiKey: canary, expectedCurrentId: null });
  const reference = await store.select('openai', 'gpt-5-mini');
  time = 2000;
  await store.save('openai', { apiKey: 'current', expectedCurrentId: first.currentId });
  time = 2000 + 7 * 86400000;
  await expect(
    new ModelCredentials(configured(), id, () => time).resolve('openai', reference),
  ).rejects.toMatchObject({ code: 'credential_unavailable' });
  await store.metadata('openai');
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM model_credentials WHERE owner=?')
      .bind(id)
      .first('n'),
  ).toBe(2);
});

it('bounds versions and revokes all retained versions with currentId CAS', async () => {
  const id = await owner(),
    store = new ModelCredentials(configured(), id);
  let currentId: string | null = null;
  for (let i = 0; i < 20; i++)
    currentId = (
      await store.save('openai', { apiKey: 'version-' + i, expectedCurrentId: currentId })
    ).currentId;
  await expect(
    store.save('openai', { apiKey: 'overflow', expectedCurrentId: currentId }),
  ).rejects.toMatchObject({ code: 'credential_version_limit' });
  const reference = await store.select('openai', 'gpt-5-mini');
  await expect(store.remove('openai', crypto.randomUUID())).rejects.toMatchObject({
    code: 'credential_conflict',
  });
  await store.remove('openai', currentId);
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS n FROM model_credentials WHERE owner=?')
      .bind(id)
      .first('n'),
  ).toBe(0);
  await expect(store.resolve('openai', reference)).rejects.toMatchObject({
    code: 'credential_unavailable',
  });
  expect(await store.remove('openai', currentId)).toMatchObject({ configured: false });
});

it('freezes server credentials and never turns a user failure into deployment fallback', async () => {
  const id = await owner(),
    store = new ModelCredentials(configured(), id);
  const server = await store.select('openai', 'gpt-5-mini');
  expect(server).toMatchObject({ source: 'server' });
  await expect(
    new ModelCredentials({ ...configured(), MODEL_API_KEY: 'rotated' }, id).resolve(
      'openai',
      server,
    ),
  ).rejects.toMatchObject({ code: 'credential_configuration_changed' });
  await expect(
    new ModelCredentials({ ...configured(), ALLOW_SERVER_MODEL_KEY: '0' }, id).select(
      'openai',
      'gpt-5-mini',
    ),
  ).rejects.toMatchObject({ code: 'credential_required' });
  await store.save('openai', { apiKey: canary, expectedCurrentId: null });
  const personal = await store.select('openai', 'gpt-5-mini');
  await store.remove('openai', (await store.metadata('openai')).currentId);
  await expect(store.resolve('openai', personal)).rejects.toMatchObject({
    code: 'credential_unavailable',
  });
});

it('binds the destination to the immutable encrypted Key version, including after reconstruction', async () => {
  const id = await owner(),
    store = new ModelCredentials(configured(), id);
  const first = await store.save('openai', {
    apiKey: canary,
    baseUrl: 'https://first.example.com/v1/',
    expectedCurrentId: null,
  });
  const reference = await store.select('openai', 'gpt-5-mini');
  const second = await store.save('openai', {
    apiKey: 'new-key',
    baseUrl: 'https://second.example.com/v1',
    expectedCurrentId: first.currentId,
  });
  expect(second.baseUrl).toBe('https://second.example.com/v1');
  expect(await new ModelCredentials(configured(), id).resolve('openai', reference)).toEqual({
    apiKey: canary,
    baseUrl: 'https://first.example.com/v1',
  });
  await env.DB.prepare('UPDATE model_credentials SET base_url=? WHERE id=?')
    .bind('https://attacker.example.com/v1', first.currentId)
    .run();
  await expect(store.resolve('openai', reference)).rejects.toMatchObject({
    code: 'credential_decryption_failed',
  });
});

it('limits deployment credentials to configured free models while personal credentials may override', async () => {
  const store = new ModelCredentials(
    { ...configured(), MODEL_PROVIDER: 'openrouter', MODEL_ID: 'openrouter/free' },
    await owner(),
  );
  expect(await store.select('openrouter', 'openrouter/free')).toMatchObject({ source: 'server' });
  await expect(store.select('openrouter', 'openai/gpt-5-mini')).rejects.toMatchObject({
    code: 'model_not_allowed',
  });
  await store.save('openrouter', {
    apiKey: canary,
    modelId: 'openai/gpt-5-mini',
    expectedCurrentId: null,
  });
  const personal = await store.select('openrouter', 'openai/gpt-5-mini');
  expect(personal).toMatchObject({ source: 'user' });
  expect(await store.resolve('openrouter', personal)).toEqual({ apiKey: canary });
});

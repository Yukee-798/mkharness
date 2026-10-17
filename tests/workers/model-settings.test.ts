import { env } from './env';
import { expect, it } from 'vitest';
import app from '../../src/server/index';
const origin = 'http://localhost:5173';
async function guest() {
  const settingsEnv = {
    ...env,
    AUTH_MODE: 'guest',
    MODEL_PROVIDER: '',
    MODEL_ID: '',
    MODEL_API_KEY: '',
    CREDENTIAL_ENCRYPTION_KEY: btoa('m'.repeat(32)),
  };
  const response = await app.request(
    origin + '/api/auth/sign-in/anonymous',
    { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: '{}' },
    settingsEnv,
  );
  const cookie = response.headers.get('set-cookie')!.match(/better-auth\.session_token=[^;]+/)![0];
  return { settingsEnv, headers: { cookie, origin, 'Content-Type': 'application/json' } };
}

it('reads the static provider catalog without a key, supplier request, or DO', async () => {
  const { settingsEnv, headers } = await guest();
  const response = await app.request(origin + '/api/settings/models', { headers }, {
    ...settingsEnv,
    CONVERSATIONS: {
      getByName() {
        throw new Error('settings acquired DO');
      },
    },
  } as any);
  expect(response.status).toBe(200);
  const settings = (await response.json()) as any;
  expect(settings.providers.map((provider: any) => provider.id)).toEqual([
    'openai',
    'anthropic',
    'deepseek',
    'openrouter',
  ]);
  expect(settings.modelCatalog.defaultSelection).toMatchObject({
    provider: 'deepseek',
    modelId: 'deepseek-flash',
  });
  expect(settings.modelCatalog.models.map((model: any) => model.id)).toEqual(['deepseek-flash']);
  expect(
    settings.credentials.every((credential: any) => credential.effectiveSource === 'none'),
  ).toBe(true);
  expect(settings.credentialStorageReady).toBe(true);
});

it('only returns metadata on credential writes and keeps other owners separate', async () => {
  const a = await guest(),
    b = await guest();
  const saved = await app.request(
    origin + '/api/settings/model-credentials/openai',
    {
      method: 'PUT',
      headers: a.headers,
      body: JSON.stringify({
        apiKey: 'http-canary',
        baseUrl: 'https://gateway.example.com/v1',
        expectedCurrentId: null,
      }),
    },
    a.settingsEnv,
  );
  expect(saved.status).toBe(200);
  const body = await saved.text();
  expect(body).not.toContain('http-canary');
  expect(body).not.toContain('ciphertext');
  const first = JSON.parse(body);
  expect(first.baseUrl).toBe('https://gateway.example.com/v1');
  const conflict = await app.request(
    origin + '/api/settings/model-credentials/openai',
    {
      method: 'PUT',
      headers: a.headers,
      body: JSON.stringify({ apiKey: 'second', expectedCurrentId: null }),
    },
    a.settingsEnv,
  );
  expect(conflict.status).toBe(409);
  const other = await app.request(
    origin + '/api/settings/models',
    { headers: b.headers },
    b.settingsEnv,
  );
  expect(
    ((await other.json()) as any).credentials.find((item: any) => item.provider === 'openai')
      .configured,
  ).toBe(false);
  const removed = await app.request(
    origin + '/api/settings/model-credentials/openai',
    {
      method: 'DELETE',
      headers: a.headers,
      body: JSON.stringify({ expectedCurrentId: first.currentId }),
    },
    a.settingsEnv,
  );
  expect(removed.status).toBe(200);
});

it('enforces session, Origin, registered providers and bounded strict input before writes', async () => {
  const { settingsEnv, headers } = await guest();
  const url = origin + '/api/settings/model-credentials/';
  expect((await app.request(origin + '/api/settings/models', {}, settingsEnv)).status).toBe(401);
  expect(
    (
      await app.request(
        url + 'openai',
        { method: 'PUT', headers: { ...headers, origin: 'https://evil.test' }, body: '{}' },
        settingsEnv,
      )
    ).status,
  ).toBe(403);
  expect(
    (await app.request(url + 'unregistered', { method: 'PUT', headers, body: '{}' }, settingsEnv))
      .status,
  ).toBe(400);
  for (const body of [
    '{',
    '{}',
    ...[
      'http://example.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://10.0.0.1',
      'https://user:pass@example.com',
      'https://example.com?key=secret',
      'https://example.com#secret',
      '',
    ].map((baseUrl) => JSON.stringify({ apiKey: 'valid', baseUrl, expectedCurrentId: null })),
    JSON.stringify({ apiKey: 'valid', expectedCurrentId: null, owner: 'someone' }),
    JSON.stringify({ apiKey: 'a'.repeat(8193), expectedCurrentId: null }),
  ])
    expect(
      (await app.request(url + 'openai', { method: 'PUT', headers, body }, settingsEnv)).status,
    ).toBe(400);
});

it('saves a registered API model name, narrows public choices and rejects unknown names before rotating the key', async () => {
  const { settingsEnv, headers } = await guest();
  const url = origin + '/api/settings/model-credentials/deepseek';
  const save = await app.request(
    url,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        apiKey: 'model-name-canary',
        modelId: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
        expectedCurrentId: null,
      }),
    },
    settingsEnv,
  );
  expect(save.status).toBe(200);
  const saved = (await save.json()) as any;
  expect(saved.modelId).toBe('deepseek-v4-pro');
  const settings = (await (
    await app.request(origin + '/api/settings/models', { headers }, settingsEnv)
  ).json()) as any;
  expect(settings.modelCatalog.models.map((model: any) => model.id)).toEqual(['deepseek-v4-pro']);
  expect(settings.modelCatalog.defaultSelection).toMatchObject({
    modelId: 'deepseek-v4-pro',
    thinkingLevel: 'high',
  });
  expect(JSON.stringify(settings)).not.toContain('model-name-canary');
  const invalid = await app.request(
    url,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        apiKey: 'replacement',
        modelId: 'not-registered',
        expectedCurrentId: saved.currentId,
      }),
    },
    settingsEnv,
  );
  expect(invalid.status).toBe(400);
  const unchanged = (await (
    await app.request(origin + '/api/settings/models', { headers }, settingsEnv)
  ).json()) as any;
  expect(unchanged.credentials.find((item: any) => item.provider === 'deepseek').currentId).toBe(
    saved.currentId,
  );
});

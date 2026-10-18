import { snapshotFixture } from './chat-fixtures';
import { test, expect } from '@playwright/test';
import { seedAccount } from './account-fixture';
test.beforeEach(async ({ context }, info) => {
  if (!info.title.startsWith('signed-out')) await seedAccount(context);
  await context.addInitScript(() => localStorage.setItem('mkharness.locale', 'zh-CN'));
});
test('signed-out browsers show Google sign-in without creating an identity', async ({
  page,
  context,
}) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) calls.push(r.method() + ' ' + new URL(r.url()).pathname);
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  expect(await (await context.request.get('/api/auth/get-session')).json()).toBeNull();
  expect(
    calls.some((p) => p.includes('/sign-in/anonymous') || p === 'POST /api/conversations'),
  ).toBe(false);
  expect((await context.request.post('/api/auth/sign-in/anonymous', { data: {} })).status()).toBe(
    404,
  );
});
test('metadata-only settings, credential preflight and saved Base URL survive reload', async ({
  page,
  context,
}) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) calls.push(r.method() + ' ' + new URL(r.url()).pathname);
  });
  await page.goto('/');
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  const settings = await (await context.request.get('/api/settings/models')).json();
  const selected = settings.modelCatalog.models.find((m: any) => m.provider === 'deepseek');
  expect(selected).toBeTruthy();
  await page.getByLabel('模型与思考强度', { exact: true }).click();
  if (settings.modelCatalog.models.length > 5)
    await page.getByPlaceholder('搜索模型…').fill(selected.name);
  await page.getByRole('option', { name: selected.name, exact: true }).click();
  await page.getByRole('button', { name: '账号：Test account' }).click();
  await page.getByRole('menuitem', { name: '设置' }).click();
  await page.getByRole('tab', { name: '模型与 API Key' }).click();
  await expect(page.getByLabel('Base URL', { exact: true })).toHaveValue(
    'https://api.deepseek.com',
  );
  await expect(page.getByLabel('Base URL', { exact: true })).toHaveAttribute('data-slot', 'input');
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByLabel('消息', { exact: true }).fill('retained draft');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Base URL', { exact: true })).toHaveValue(
    'https://api.deepseek.com',
  );
  await expect(page.getByRole('dialog').locator('select')).toHaveCount(0);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('retained draft');
  expect(calls.filter((p) => p === 'POST /api/conversations')).toHaveLength(0);
  await page.getByLabel('Base URL', { exact: true }).fill('https://custom.example.com/v1');
  await page.getByLabel('API Key', { exact: true }).fill('E2E-CANARY-PERSONAL');
  await page.getByRole('button', { name: '保存配置' }).click();
  await expect(page.getByText('已保存，尚未验证连接')).toBeVisible();
  const data = await (await context.request.get('/api/settings/models')).json();
  expect(data.credentials.find((c: any) => c.provider === 'deepseek')).toMatchObject({
    effectiveSource: 'user',
    baseUrl: 'https://custom.example.com/v1',
  });
  expect(JSON.stringify(data)).not.toContain('E2E-CANARY');
  await page.getByRole('button', { name: '关闭' }).click();
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  const persisted = await (await context.request.get('/api/settings/models')).json();
  expect(persisted.credentials.find((c: any) => c.provider === 'deepseek').baseUrl).toBe(
    'https://custom.example.com/v1',
  );
});
test('first submission retains conversation and run identity after an uncertain receipt', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  await context.request.put('/api/settings/model-credentials/deepseek', {
    headers: { Origin: 'http://localhost:5174' },
    data: { apiKey: 'E2E-CANARY-PERSONAL', expectedCurrentId: null },
  });
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  let creates = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/conversations') creates++;
  });
  const commands: any[] = [];
  await page.route('**/api/conversations/*/runs', (route) => {
    commands.push(route.request().postDataJSON());
    return commands.length === 1
      ? route.abort('failed')
      : route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.route('**/api/conversations/*/snapshot*', (route) =>
    route.fulfill({ json: snapshotFixture({ entries: [], pending: [], stopping: false }) }),
  );
  await page.getByLabel('消息', { exact: true }).fill('hello');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page).toHaveURL(/chat=/);
  await expect(page.getByRole('button', { name: '重试提交', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重试提交', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(creates).toBe(1);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[0].config.provider).toBe('deepseek');
  expect(commands[0]).not.toHaveProperty('credentialRef');
});

import { test, expect } from '@playwright/test';
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem('mkharness.locale', 'zh-CN'));
});
test('native anonymous identity survives reload, shares tabs and isolates browsers', async ({
  page,
  context,
  browser,
}) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) calls.push(r.method() + ' ' + new URL(r.url()).pathname);
  });
  await page.goto('/');
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '账号：此浏览器的访客' })).toBeVisible();
  expect(calls.filter((p) => p === 'POST /api/auth/sign-in/anonymous')).toHaveLength(1);
  expect(calls.some((p) => p === 'POST /api/conversations' || p.endsWith('/events'))).toBe(false);
  const first = await (await context.request.get('/api/auth/get-session')).json();
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  const restored = await (await context.request.get('/api/auth/get-session')).json();
  expect(restored.user.id).toBe(first.user.id);
  const sharedTab = await context.newPage();
  const sharedCalls: string[] = [];
  sharedTab.on('request', (r) => sharedCalls.push(new URL(r.url()).pathname));
  await sharedTab.goto('/');
  await expect(sharedTab.getByLabel('消息', { exact: true })).toBeVisible();
  expect(sharedCalls.filter((p) => p === '/api/auth/sign-in/anonymous')).toHaveLength(0);
  expect((await (await context.request.get('/api/auth/get-session')).json()).user.id).toBe(
    first.user.id,
  );
  await sharedTab.close();
  const other = await browser.newContext();
  try {
    const tab = await other.newPage();
    await tab.goto('/');
    await expect(
      tab.getByPlaceholder('Describe your question or what you want to do'),
    ).toBeVisible();
    const another = await (await other.request.get('/api/auth/get-session')).json();
    expect(another.user.id).not.toBe(first.user.id);
  } finally {
    await other.close();
  }
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
  await page.getByRole('button', { name: '账号：此浏览器的访客' }).click();
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
    route.fulfill({ json: { entries: [], pending: [], stopping: false } }),
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

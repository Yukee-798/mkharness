import { test, expect } from './fixtures';

test.use({ uiLocale: 'en' });
for (const mobile of [false, true]) {
  test(`settings language and credential drafts remain stable (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const calls: string[] = [];
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      calls.push(req.method() + ' ' + path);
      if (path.includes('/auth/get-session'))
        return route.fulfill({
          json: {
            session: {
              id: 'session',
              userId: 'owner',
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
            user: { id: 'owner', name: 'Test User', email: 'test@example.com', isAnonymous: false },
          },
        });
      if (path === '/api/conversations')
        return route.fulfill({ json: { items: [], cursor: null } });
      if (path === '/api/settings/models')
        return route.fulfill({
          json: {
            providers: [
              {
                id: 'deepseek',
                name: 'DeepSeek',
                defaultModelId: 'deepseek-flash',
                baseUrl: 'https://api.deepseek.com',
              },
            ],
            modelCatalog: {
              models: [
                {
                  id: 'deepseek-flash',
                  name: 'DeepSeek',
                  provider: 'deepseek',
                  thinkingLevels: ['off', 'low'],
                },
              ],
              defaultSelection: {
                provider: 'deepseek',
                modelId: 'deepseek-flash',
                thinkingLevel: 'off',
              },
            },
            credentials: [
              {
                provider: 'deepseek',
                currentId: null,
                baseUrl: null,
                configured: false,
                updatedAt: null,
                effectiveSource: 'none',
                serverDefaultAllowed: false,
              },
            ],
            credentialStorageReady: true,
          },
        });
      await route.fallback();
    });
    await page.goto('/');
    await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
    await page.getByLabel('Message', { exact: true }).fill('Keep my unsent message');
    const composer = await page.getByLabel('Message', { exact: true }).elementHandle();
    if (mobile) await page.getByRole('button', { name: 'Open conversations', exact: true }).click();
    await page.getByRole('button', { name: 'Account: Test User', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(dialog.getByRole('button', { name: 'System', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dialog.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await dialog.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await dialog.getByRole('button', { name: 'System', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect(dialog.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(dialog.getByRole('tablist')).toHaveAttribute(
      'aria-orientation',
      mobile ? 'horizontal' : 'vertical',
    );
    await dialog.getByRole('tab', { name: 'General', exact: true }).focus();
    await page.keyboard.press(mobile ? 'ArrowRight' : 'ArrowDown');
    await expect(
      dialog.getByRole('tab', { name: 'Models & API Key', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    // Read both rectangles in the same frame, including while the Dialog is animating in.
    const placement = await dialog.evaluate((element) => {
      const nav = element.querySelector('[role="tablist"]')!.getBoundingClientRect();
      const panel = element
        .querySelector('[role="tabpanel"][data-state="active"]')!
        .getBoundingClientRect();
      return { horizontalGap: panel.left - nav.right, verticalGap: panel.top - nav.bottom };
    });
    expect(mobile ? placement.verticalGap : placement.horizontalGap).toBeGreaterThanOrEqual(-1);
    await dialog.getByLabel('API Key', { exact: true }).fill('UNSAVED-E2E-CANARY');
    const key = await dialog.getByLabel('API Key', { exact: true }).elementHandle();
    await dialog.getByRole('tab', { name: 'General', exact: true }).click();
    const before = calls.length;
    await dialog.getByRole('button', { name: 'Dark', exact: true }).click();
    await dialog.getByRole('button', { name: 'Language', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '中文', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem('mkharness.theme'))).toBe('dark');
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '模型与 API Key', exact: true }).click();
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('UNSAVED-E2E-CANARY');
    expect(await key!.evaluate((el) => el.isConnected)).toBe(true);
    expect(calls).toHaveLength(before);
    expect(calls.filter((c) => c.startsWith('POST') || c.startsWith('PUT'))).toEqual([]);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    if (mobile) await page.getByRole('button', { name: '关闭聊天目录', exact: true }).click();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Keep my unsent message');
    expect(await composer!.evaluate((el) => el.isConnected)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('mkharness.locale'))).toBe('zh-CN');
    await page.reload();
    await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.locator('html')).toHaveClass(/dark/);
    // Opt-out: unsaved credentials are not persisted while the language preference is.
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
      'UNSAVED-E2E-CANARY',
    );
  });
}

test('language and theme switching preserve the active SSE observer and runtime', async ({
  page,
}) => {
  let observations = 0,
    snapshots = 0,
    submissions = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/auth/get-session'))
      return route.fulfill({
        json: {
          session: {
            id: 'session',
            userId: 'owner',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
          user: { id: 'owner', name: 'Test User', email: 'test@example.com', isAnonymous: false },
        },
      });
    if (path === '/api/conversations')
      return route.fulfill({
        json: { items: [{ id: 'a', title: 'Live chat', updated_at: Date.now() }], next: null },
      });
    if (path.endsWith('/snapshot')) {
      snapshots++;
      return route.fulfill({
        json: {
          entries: [
            {
              id: 1,
              model: [{ role: 'assistant', content: [{ type: 'text', text: 'Existing answer' }] }],
            },
          ],
          pending: [{ operationId: '11111111-1111-4111-8111-111111111111', status: 'running' }],
          stopping: false,
        },
      });
    }
    if (path.endsWith('/events')) {
      observations++;
      await held;
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    }
    if (path.endsWith('/runs')) submissions++;
    await route.fallback();
  });
  try {
    await page.goto('/?chat=a');
    await expect.poll(() => observations).toBe(1);
    await expect(page.getByText('Existing answer', { exact: true })).toBeVisible();
    const composer = page.getByLabel('Message', { exact: true });
    await composer.fill('Unsent live draft');
    const node = await composer.elementHandle();
    const before = snapshots;
    await page.getByRole('button', { name: 'Account: Test User', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: 'System', exact: true }).click();
    await page.getByRole('button', { name: 'Language', exact: true }).click();
    await page.getByRole('menuitemradio', { name: '中文', exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Unsent live draft');
    await expect(page.getByText('Existing answer', { exact: true })).toBeVisible();
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    expect(observations).toBe(1);
    expect(snapshots).toBe(before);
    expect(submissions).toBe(0);
  } finally {
    release();
  }
});

import { test, expect } from '@playwright/test';
test('Google sign-in delegates to Better Auth and reports missing configuration', async ({
  page,
}) => {
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: null }));
  let signedIn = false;
  await page.route('**/api/auth/sign-in/social', async (route) => {
    signedIn = route.request().postDataJSON().provider === 'google';
    await route.fulfill({ status: 503, json: { message: 'Configure Google OAuth credentials' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '使用 Google 登录' }).click();
  await expect(page.getByRole('alert')).toContainText('Configure Google OAuth');
  expect(signedIn).toBe(true);
});
test('personal directory creates and restores a chat with keyboard access on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      json: {
        session: { id: 'session', userId: 'user', expiresAt: '2027-01-01T00:00:00Z' },
        user: { id: 'user', name: 'Yukee', email: 'user@example.test' },
      },
    }),
  );
  await page.route('**/api/conversations', (route) =>
    route.fulfill({
      status: route.request().method() === 'POST' ? 201 : 200,
      json:
        route.request().method() === 'POST'
          ? { id: 'created', title: '新聊天' }
          : {
              items: [{ id: 'existing', title: '方案比较', updated_at: 1791576000000 }],
              next: null,
            },
    }),
  );
  await page.route('**/api/conversations/*/snapshot', (route) =>
    route.fulfill({ json: { entries: [], pending: [], stopping: false } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '打开聊天目录' }).click();
  await page.getByRole('button', { name: '新建聊天', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('chat')).toBe('created');
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开聊天目录' }).click();
  await page.getByRole('button', { name: '方案比较' }).click();
  expect(new URL(page.url()).searchParams.get('chat')).toBe('existing');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

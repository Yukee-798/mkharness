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
  let created = false;
  await page.route('**/api/conversations', (route) => {
    if (route.request().method() === 'POST') created = true;
    return route.fulfill({
      status: route.request().method() === 'POST' ? 201 : 200,
      json:
        route.request().method() === 'POST'
          ? { id: 'created', title: '新聊天' }
          : {
              items: [
                ...(created ? [{ id: 'created', title: '新聊天', updated_at: 1791576000001 }] : []),
                { id: 'existing', title: '方案比较', updated_at: 1791576000000 },
              ],
              next: null,
            },
    });
  });
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

test('directory updates automatically after sending and returning without dropping loaded pages', async ({
  page,
}) => {
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      json: {
        session: { id: 'session', userId: 'user', expiresAt: '2027-01-01T00:00:00Z' },
        user: { id: 'user', name: 'Yukee', email: 'user@example.test' },
      },
    }),
  );
  let title = '新聊天';
  let submissions = 0;
  let externalChat = false;
  await page.route('**/api/conversations**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/snapshot'))
      return route.fulfill({ json: { entries: [], pending: [], stopping: false } });
    if (url.pathname.endsWith('/runs')) {
      submissions++;
      title = route.request().postDataJSON().text;
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    if (url.searchParams.has('cursor'))
      return route.fulfill({
        json: {
          items: [{ id: 'older', title: '较早的聊天', updated_at: 1791576000000 }],
          next: null,
        },
      });
    return route.fulfill({
      json: {
        items: [
          ...(externalChat
            ? [{ id: 'external', title: '另一页面的新聊天', updated_at: 1791576000002 }]
            : []),
          { id: 'current', title, updated_at: 1791576000001 },
        ],
        next: '100',
      },
    });
  });
  await page.goto('/?chat=current');
  const directory = page.getByRole('navigation', { name: '聊天记录' });
  await directory.getByRole('button', { name: '更多聊天' }).click();
  await expect(directory.getByRole('button', { name: '较早的聊天' })).toBeVisible();
  await expect(page.getByText('今天想解决什么问题？', { exact: true })).toBeVisible();
  await page.getByLabel('消息', { exact: true }).fill('自动同步的标题');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(directory.getByRole('button', { name: '自动同步的标题' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '自动同步的标题', exact: true })).toBeVisible();
  await expect(directory.getByRole('button', { name: '较早的聊天' })).toBeVisible();
  await page.getByLabel('消息', { exact: true }).fill('尚未发送的草稿');
  externalChat = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(directory.getByRole('button', { name: '另一页面的新聊天' })).toBeVisible();
  await expect(directory.getByRole('button', { name: '较早的聊天' })).toBeVisible();
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('尚未发送的草稿');
  await expect(page.getByRole('button', { name: '刷新目录' })).toHaveCount(0);
  expect(submissions).toBe(1);
});

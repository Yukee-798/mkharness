import { snapshotFixture } from './chat-fixtures';
import { test, expect } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ json: { extensionIds: ['web', 'openui', 'example'] } }),
  );
});

test('a directory read failure cannot reject a successfully created chat', async ({ page }) => {
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      json: {
        session: { id: 'session', userId: 'user', expiresAt: '2027-01-01T00:00:00Z' },
        user: { id: 'user', name: 'User', email: 'user@example.test' },
      },
    }),
  );
  let created = false;
  await page.route('**/api/conversations', (route) => {
    if (route.request().method() === 'POST') {
      created = true;
      return route.fulfill({ status: 201, json: { id: 'created', title: '新聊天' } });
    }
    if (created)
      return route.fulfill({
        status: 503,
        json: { error: { code: 'directory_unavailable' } },
      });
    return route.fulfill({
      json: { items: [{ id: 'existing', title: '旧聊天', updated_at: 1 }], next: null },
    });
  });
  await page.route('**/api/conversations/*/snapshot*', (route) =>
    route.fulfill({ json: snapshotFixture({ entries: [], pending: [], stopping: false }) }),
  );
  await page.route('**/api/conversations/*/runs', (route) =>
    route.fulfill({ status: 202, json: { accepted: true } }),
  );
  await page.goto('/?chat=existing');
  await expect(page.getByRole('button', { name: '旧聊天', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建聊天', exact: true }).click();
  await expect(page).not.toHaveURL(/chat=/);
  const composer = page.getByLabel('消息', { exact: true });
  await composer.fill('first message');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page).toHaveURL(/chat=created/);
  await composer.fill('new chat draft');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/chat=created/);
  await expect(composer).toHaveValue('new chat draft');
});

test('signed-out login stays at the sidebar bottom and is accessible when collapsed', async ({
  page,
}) => {
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: null }));
  await page.goto('/');
  const login = page.getByRole('button', { name: '使用 Google 登录', exact: true });
  await expect(login).toBeVisible();
  const bounds = await login.boundingBox();
  const size = page.viewportSize()!;
  expect(bounds!.x).toBeLessThan(260);
  expect(bounds!.y).toBeGreaterThan(size.height - 100);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(login).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
});

test('sidebar collapse retains the chat and draft; bottom account menu reports sign-out errors', async ({
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
  let snapshots = 0;
  let releaseInitial!: () => void;
  const initialRead = new Promise<void>((resolve) => (releaseInitial = resolve));
  await page.route('**/api/conversations', (route) =>
    route.fulfill({
      json: {
        items: [{ id: 'current', title: '当前聊天', updated_at: 1791576000000 }],
        next: null,
      },
    }),
  );
  await page.route('**/api/conversations/current/snapshot*', async (route) => {
    snapshots++;
    await initialRead;
    return route.fulfill({ json: snapshotFixture({ entries: [], pending: [], stopping: false }) });
  });
  await page.route('**/api/auth/sign-out', (route) =>
    route.fulfill({ status: 500, json: { message: '暂时无法退出，请重试' } }),
  );
  await page.goto('/?chat=current');
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(page.getByRole('status').filter({ hasText: '正在恢复聊天…' })).toBeVisible();
  await expect(composer).toHaveCount(0);
  releaseInitial();
  await composer.fill('尚未发送的草稿');
  const original = await composer.elementHandle();
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '聊天记录' })).not.toBeVisible();
  await expect(composer).toHaveValue('尚未发送的草稿');
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).press('Enter');
  await expect(page.getByRole('navigation', { name: '聊天记录' })).toBeVisible();
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
  expect(snapshots).toBeGreaterThanOrEqual(1); // Query may refresh read cache on window focus.
  const account = page.getByRole('button', { name: '账号：Yukee', exact: true });
  const bounds = await account.boundingBox();
  expect(bounds!.y).toBeGreaterThan(page.viewportSize()!.height - 100);
  await account.press('Enter');
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('暂时无法退出');
  await expect(composer).toHaveValue('尚未发送的草稿');
});

test('mobile drawer exposes bottom login and reveals an OAuth error after closing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: null }));
  await page.route('**/api/auth/sign-in/social', (route) =>
    route.fulfill({ status: 503, json: { message: 'Configure Google OAuth credentials' } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '打开聊天目录' }).click();
  const login = page.getByRole('button', { name: '使用 Google 登录', exact: true });
  await expect(login).toBeVisible();
  expect((await login.boundingBox())!.y).toBeGreaterThan(744);
  await login.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Configure Google OAuth');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('signed-out landing can scroll on a short viewport without moving the login footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 320 });
  await page.route('**/api/auth/get-session', (route) => route.fulfill({ json: null }));
  await page.route('**/api/auth/sign-in/social', (route) =>
    route.fulfill({ status: 503, json: { message: 'Configure Google OAuth credentials' } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '使用 Google 登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Configure Google OAuth');
  const scrollable = await page
    .getByRole('main')
    .evaluate((main) =>
      [...main.querySelectorAll('*')].some(
        (node) =>
          node.scrollHeight > node.clientHeight &&
          /auto|scroll/.test(getComputedStyle(node).overflowY),
      ),
    );
  expect(scrollable).toBe(true);
  const help = page.getByText('从侧栏底部使用 Google 登录。聊天和输入仅保存在你的个人会话中。', {
    exact: true,
  });
  await help.scrollIntoViewIfNeeded();
  const bounds = (await help.boundingBox())!;
  // Scrolling rounds to whole pixels while text bounds can retain subpixel fractions.
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await expect(
    page.getByRole('button', { name: '使用 Google 登录', exact: true }),
  ).toBeInViewport();
});

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
  await page.route('**/api/conversations/*/snapshot*', (route) =>
    route.fulfill({ json: snapshotFixture({ entries: [], pending: [], stopping: false }) }),
  );
  await page.route('**/api/conversations/*/runs', (route) =>
    route.fulfill({ status: 202, json: { accepted: true } }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '打开聊天目录' }).click();
  const account = page.getByRole('button', { name: '账号：Yukee', exact: true });
  await expect(account).toBeVisible();
  expect((await account.boundingBox())!.y).toBeGreaterThan(744);
  await page.getByRole('button', { name: '新建聊天', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'MkHarness', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
  expect(created).toBe(false);
  expect(new URL(page.url()).searchParams.has('chat')).toBe(false);
  await page.getByLabel('消息', { exact: true }).fill('first message');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page).toHaveURL(/chat=created/);
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
      return route.fulfill({
        json: snapshotFixture({ entries: [], pending: [], stopping: false }),
      });
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

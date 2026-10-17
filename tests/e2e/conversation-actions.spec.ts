import { snapshotFixture } from './chat-fixtures';
import { test, expect, type Page } from './fixtures';

async function workspace(page: Page) {
  const chats = [
    { id: 'a', title: '任务规划', updated_at: 1791576000001 },
    { id: 'b', title: '另一聊天', updated_at: 1791576000000 },
  ];
  const mutations: string[] = [];
  let failDelete = false;
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      json: {
        session: { id: 'session', userId: 'user', expiresAt: '2027-01-01T00:00:00Z' },
        user: { id: 'user', name: 'User', email: 'user@example.test' },
      },
    }),
  );
  await page.route('**/api/conversations**', (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/conversations')
      return route.fulfill({ json: { items: chats, next: null } });
    const id = url.pathname.split('/')[3];
    const chat = chats.find((chat) => chat.id === id);
    if (!chat) return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    if (url.pathname.endsWith('/snapshot'))
      return route.fulfill({
        json: snapshotFixture({ entries: [], pending: [], stopping: false }),
      });
    mutations.push(method);
    if (method === 'PATCH') {
      chat.title = route.request().postDataJSON().title;
      return route.fulfill({ json: chat });
    }
    if (method === 'DELETE') {
      if (failDelete) {
        failDelete = false;
        return route.fulfill({
          status: 500,
          json: { error: { code: 'failed', message: '暂时无法删除，请重试' } },
        });
      }
      chats.splice(chats.indexOf(chat), 1);
      return route.fulfill({ status: 202, json: { deleting: true } });
    }
    return route.fulfill({ status: 400, json: { error: { code: 'unexpected' } } });
  });
  await page.goto('/?chat=a');
  await expect(page.getByText('今天想解决什么问题？', { exact: true })).toBeVisible();
  return {
    chats,
    mutations,
    failNextDelete: () => {
      failDelete = true;
    },
  };
}

for (const mobile of [false, true]) {
  test(`chat rename and confirmed deletion restore selection on ${mobile ? 'mobile' : 'desktop'}`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const { mutations } = await workspace(page);
    if (mobile) await page.getByRole('button', { name: '打开聊天目录' }).click();
    await page
      .getByRole('group', { name: '聊天：任务规划', exact: true })
      .getByRole('button', { name: '聊天操作' })
      .click();
    await page.getByRole('menuitem', { name: '重命名' }).click();
    const input = page.getByRole('textbox', { name: '聊天名称' });
    await input.fill('   ');
    await expect(page.getByRole('button', { name: '保存名称' })).toBeDisabled();
    await input.fill('重新命名的聊天');
    await input.press('Enter');
    await expect(page.getByRole('dialog', { name: '重命名聊天' })).toHaveCount(0);
    if (mobile) await page.getByRole('button', { name: '关闭聊天目录' }).click();
    await expect(page.getByRole('heading', { name: '重新命名的聊天', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '重新命名的聊天', exact: true })).toBeVisible();
    if (mobile) await page.getByRole('button', { name: '打开聊天目录' }).click();
    const row = page.getByRole('group', { name: '聊天：重新命名的聊天', exact: true });
    await row.getByRole('button', { name: '聊天操作' }).click();
    await page.getByRole('menuitem', { name: '删除聊天' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('当前任务会停止');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(mutations).toEqual(['PATCH']);
    await row.getByRole('button', { name: '聊天操作' }).click();
    await page.getByRole('menuitem', { name: '删除聊天' }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByRole('heading', { name: '另一聊天', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('chat')).toBe('b');
    if (mobile) await page.getByRole('button', { name: '打开聊天目录' }).click();
    await page
      .getByRole('group', { name: '聊天：另一聊天', exact: true })
      .getByRole('button', { name: '聊天操作' })
      .click();
    await page.getByRole('menuitem', { name: '删除聊天' }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByText('今天想解决什么问题？', { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]chat=/);
    expect(mutations).toEqual(['PATCH', 'DELETE', 'DELETE']);
  });
}

test('a failed deletion remains retryable and a chat deleted elsewhere closes on return', async ({
  page,
}) => {
  const { mutations, failNextDelete, chats } = await workspace(page);
  failNextDelete();
  await page
    .getByRole('group', { name: '聊天：任务规划', exact: true })
    .getByRole('button', { name: '聊天操作' })
    .click();
  await page.getByRole('menuitem', { name: '删除聊天' }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('暂时无法删除');
  expect(new URL(page.url()).searchParams.get('chat')).toBe('a');
  expect(chats).toHaveLength(2);
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('heading', { name: '另一聊天', exact: true })).toBeVisible();
  expect(mutations).toEqual(['DELETE', 'DELETE']);
  chats.length = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('今天想解决什么问题？', { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]chat=/);
});

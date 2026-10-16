import { test, expect, type Page } from './fixtures';

async function workspace(page: Page) {
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
    if (route.request().method() === 'POST') {
      created = true;
      return route.fulfill({ status: 201, json: { id: 'created' } });
    }
    return route.fulfill({
      json: {
        items: [
          ...(created ? [{ id: 'created', title: 'Created chat', updated_at: 1791576000001 }] : []),
          { id: 'existing', title: 'Existing chat', updated_at: 1791576000000 },
        ],
        next: null,
      },
    });
  });
}
const entries = (text: string) => [
  { id: 1, model: [{ role: 'user', content: text }] },
  { id: 2, model: [{ role: 'assistant', content: [{ type: 'text', text: 'Finished answer' }] }] },
];

test('creation works while OpenUI is loading, retains the message across chats, then adopts Pi history once', async ({
  page,
}) => {
  await workspace(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let openuiRequested = false;
  await page.route(/\/assets\/browser-[^/]+\.js$/, async (route) => {
    const response = await route.fetch();
    if ((await response.text()).includes('present_openui')) {
      openuiRequested = true;
      await held;
    }
    await route.fulfill({ response });
  });
  let accepted = false,
    submissions = 0,
    observations = 0,
    snapshots = 0;
  await page.route('**/api/conversations/*/runs', async (route) => {
    submissions++;
    await held;
    accepted = true;
    await route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.route('**/api/conversations/*/snapshot*', async (route) => {
    const captured = accepted;
    if (route.request().url().includes('/created/')) {
      snapshots++;
      if (snapshots === 1) await held;
    }
    return route.fulfill({
      json: {
        entries:
          captured && route.request().url().includes('/created/') ? entries('First message') : [],
        pending: [],
        stopping: false,
      },
    });
  });
  await page.route('**/api/conversations/*/runs/*/events', (route) => {
    observations++;
    return route.fulfill({ contentType: 'text/event-stream', body: '' });
  });
  try {
    await page.goto('/');
    await expect.poll(() => openuiRequested).toBe(true);
    await page.getByLabel('消息', { exact: true }).fill('First message');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page).toHaveURL(/chat=created/);
    await expect(page.getByText('First message', { exact: true })).toHaveCount(1);
    await expect(page.getByText('提交中…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '提交中…', exact: true })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(page.getByRole('button', { name: '提交中…', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '停止并撤回排队' })).toHaveCount(0);
    await page
      .getByRole('navigation', { name: '聊天记录' })
      .getByRole('button', { name: 'Existing chat', exact: true })
      .click();
    await expect(page.getByText('First message', { exact: true })).toHaveCount(0);
    await page
      .getByRole('navigation', { name: '聊天记录' })
      .getByRole('button', { name: 'Created chat', exact: true })
      .click();
    await expect(page.getByText('First message', { exact: true })).toHaveCount(1);
    expect(submissions).toBe(1);
    expect(observations).toBe(0);
    release();
    await expect(page.getByText('Finished answer', { exact: true })).toBeVisible();
    await expect(page.getByText('First message', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '提交中…', exact: true })).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(submissions).toBe(1);
    expect(observations).toBe(0);
  } finally {
    release();
  }
});

test('a lost first receipt retries its frozen command after navigation without creating another chat or running twice', async ({
  page,
}) => {
  await workspace(page);
  const commands: any[] = [];
  const operations = new Set<string>();
  let historyAvailable = false;
  let releaseRetry!: () => void;
  const retryHeld = new Promise<void>((resolve) => (releaseRetry = resolve));
  await page.route('**/api/conversations/*/runs', async (route) => {
    const command = route.request().postDataJSON();
    commands.push(command);
    operations.add(command.runId);
    if (commands.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: { code: 'ack_lost', message: 'Receipt unavailable' } },
      });
    if (commands.length === 2) await retryHeld;
    historyAvailable = true;
    return route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.route('**/api/conversations/*/snapshot*', (route) =>
    route.fulfill({
      json: {
        entries:
          historyAvailable && route.request().url().includes('/created/')
            ? entries('Frozen message')
            : [],
        pending: [],
        stopping: false,
      },
    }),
  );
  try {
    await page.goto('/');
    await page.getByLabel('消息', { exact: true }).fill('Frozen message');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page).toHaveURL(/chat=created/);
    await expect(page.getByRole('alert')).toContainText('Receipt unavailable');
    await page
      .getByRole('navigation', { name: '聊天记录' })
      .getByRole('button', { name: 'Existing chat', exact: true })
      .click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page
      .getByRole('navigation', { name: '聊天记录' })
      .getByRole('button', { name: 'Created chat', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText('Receipt unavailable');
    await page.getByLabel('消息', { exact: true }).fill('Keep this new draft');
    await page.getByRole('button', { name: '重试提交', exact: true }).click();
    await expect(page.getByRole('button', { name: '提交中…', exact: true })).toBeDisabled();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(operations.size).toBe(1);
    releaseRetry();
    await expect(page.getByText('Finished answer', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Keep this new draft');
    await page.getByLabel('消息', { exact: true }).fill('Frozen message');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => commands.length).toBe(3);
    expect(commands[2].runId).not.toBe(commands[0].runId);
    expect(operations.size).toBe(2);
  } finally {
    releaseRetry();
  }
});

test('an accepted task observed before its HTTP receipt keeps one SSE connection when the receipt arrives', async ({
  page,
}) => {
  await workspace(page);
  let accept!: () => void, acknowledge!: () => void, finish!: () => void;
  const accepted = new Promise<void>((resolve) => (accept = resolve));
  const receipt = new Promise<void>((resolve) => (acknowledge = resolve));
  const completed = new Promise<void>((resolve) => (finish = resolve));
  let runId = '',
    done = false,
    observations = 0,
    submissions = 0;
  await page.route('**/api/conversations/*/runs', async (route) => {
    submissions++;
    runId = route.request().postDataJSON().runId;
    accept();
    await receipt;
    return route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.route('**/api/conversations/*/snapshot*', async (route) => {
    await accepted;
    return route.fulfill({
      json: {
        entries: done
          ? entries('Accepted before receipt')
          : [entries('Accepted before receipt')[0]],
        pending: done ? [] : [{ operationId: runId, status: 'running' }],
        stopping: false,
      },
    });
  });
  await page.route('**/api/conversations/*/runs/*/events', async (route) => {
    observations++;
    await completed;
    return route.fulfill({
      contentType: 'text/event-stream',
      body: [
        { type: 'RUN_STARTED', threadId: 'created', runId },
        { type: 'RUN_FINISHED', threadId: 'created', runId },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });
  try {
    await page.goto('/');
    await page.getByLabel('消息', { exact: true }).fill('Accepted before receipt');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page).toHaveURL(/chat=created/);
    await expect.poll(() => observations).toBe(1);
    await expect(page.getByText('Accepted before receipt', { exact: true })).toHaveCount(1);
    acknowledge();
    await expect(page.getByRole('button', { name: '停止并撤回排队', exact: true })).toBeEnabled();
    expect(observations).toBe(1);
    done = true;
    finish();
    await expect(page.getByText('Finished answer', { exact: true })).toBeVisible();
    expect(observations).toBe(1);
    expect(submissions).toBe(1);
  } finally {
    acknowledge();
    finish();
    accept();
  }
});

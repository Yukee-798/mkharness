import { expect, test } from '@playwright/test';

async function returnToPage(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

function answer(id: number, text: string) {
  return { id, model: [{ role: 'assistant', content: [{ type: 'text', text }] }] };
}

test('idle read refresh adopts new history and attaches externally started work once', async ({
  page,
}) => {
  let entries: ReturnType<typeof answer>[] = [];
  let pending: { operationId: string; status: string }[] = [];
  let snapshots = 0,
    observations = 0,
    submissions = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/conversations/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/snapshot')) {
      snapshots++;
      return route.fulfill({ json: { entries, pending, stopping: false } });
    }
    if (path.endsWith('/events')) {
      observations++;
      await held;
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    }
    if (path.endsWith('/runs')) submissions++;
    return route.fulfill({ status: 404 });
  });
  try {
    await page.goto('/tests/browser/chat.html');
    await expect(page.getByText('今天想解决什么问题？')).toBeVisible();
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('keep idle draft');
    const node = await composer.elementHandle();
    entries = [answer(2, 'Another tab completed this answer')];
    await returnToPage(page);
    await expect.poll(() => snapshots).toBeGreaterThan(1);
    await expect(page.getByText('Another tab completed this answer')).toBeVisible();
    expect(observations).toBe(0);
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(composer).toHaveValue('keep idle draft');
    pending = [{ operationId: '11111111-1111-4111-8111-111111111111', status: 'running' }];
    await returnToPage(page);
    await expect.poll(() => observations).toBe(1);
    const reads = snapshots;
    await returnToPage(page);
    await expect.poll(() => snapshots).toBeGreaterThan(reads);
    expect(observations).toBe(1);
    expect(submissions).toBe(0);
    await expect(composer).toHaveValue('keep idle draft');
  } finally {
    release();
  }
});

test('cached idle chat adopts fresh history when revisited without submitting or observing', async ({
  page,
}) => {
  let entries = [answer(2, 'Original cached answer')];
  let observations = 0,
    submissions = 0;
  await page.route('**/api/conversations/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/snapshot'))
      return route.fulfill({
        json: { entries: path.includes('/a/') ? entries : [], pending: [], stopping: false },
      });
    if (path.endsWith('/events')) observations++;
    if (path.endsWith('/runs')) submissions++;
    return route.fulfill({ status: 404 });
  });
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByText('Original cached answer')).toBeVisible();
  await page.getByRole('button', { name: '切换聊天' }).click();
  await expect(page.getByText('今天想解决什么问题？')).toBeVisible();
  entries = [...entries, answer(3, 'New answer while away')];
  await page.getByRole('button', { name: '切换聊天' }).click();
  await expect(page.getByText('Original cached answer')).toBeVisible();
  await expect(page.getByText('New answer while away')).toBeVisible();
  expect(observations).toBe(0);
  expect(submissions).toBe(0);
});

test('focus refetches reads without replacing the active stream or draft', async ({ page }) => {
  let snapshots = 0,
    observations = 0,
    submissions = 0;
  let finish!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve));
  await page.route('**/api/conversations/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/snapshot')) {
      snapshots++;
      return route.fulfill({
        json: {
          entries: [],
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
    return route.fulfill({ status: 404 });
  });
  try {
    await page.goto('/tests/browser/chat.html');
    await expect.poll(() => observations).toBe(1);
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('unsent draft');
    const node = await composer.elementHandle();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect.poll(() => snapshots).toBeGreaterThan(1);
    expect(observations).toBe(1);
    expect(submissions).toBe(0);
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(composer).toHaveValue('unsent draft');
  } finally {
    finish();
  }
});

import { expect, test } from '@playwright/test';

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

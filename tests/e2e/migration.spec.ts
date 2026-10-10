import { expect, test } from '@playwright/test';

test('the Start entry serves an application shell before browser JavaScript runs', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/?chat=existing-chat');
  await expect(page.getByRole('main', { name: '聊天应用' })).toBeVisible();
  await expect(page.getByRole('status')).toBeVisible();
  await context.close();
});

test('the same entry retains authenticated API boundaries instead of returning the shell', async ({
  request,
}) => {
  const response = await request.get('/api/conversations');
  expect(response.status()).toBe(401);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
});

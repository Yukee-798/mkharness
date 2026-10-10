import { test, expect } from '@playwright/test';

test('assistant markdown renders semantically and keyboard composition submits once over HTTP', async ({
  page,
}) => {
  const submitted: unknown[] = [];
  const entries = [
    {
      id: 1,
      model: [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '## 对比结果\n\n**收益**与[来源](https://example.com)\n\n| 策略 | 结果 |\n| --- | --- |\n| A | 10 |\n\n```js\nconst value = 10;\n```',
            },
          ],
        },
      ],
    },
  ];
  await page.route('**/api/conversations/**', (route) => {
    if (route.request().method() === 'POST') {
      submitted.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    return route.fulfill({ json: { entries, pending: [], stopping: false } });
  });
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByRole('heading', { name: '对比结果', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '来源', exact: true })).toHaveAttribute(
    'href',
    'https://example.com',
  );
  await expect(page.getByRole('cell', { name: '10', exact: true })).toBeVisible();
  await expect(page.locator('pre code')).toHaveText('const value = 10;');
  const input = page.getByLabel('消息', { exact: true });
  await input.fill('hello');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('hello\n');
  expect(submitted).toHaveLength(0);
  await input.press('Enter');
  await expect.poll(() => submitted.length).toBe(1);
  await expect(input).toHaveValue('');
});

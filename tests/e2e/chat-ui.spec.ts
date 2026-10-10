import { test, expect } from '@playwright/test';

test('a returned tool error is shown as a failure rather than a completed tool', async ({
  page,
}) => {
  const entries = [
    {
      id: 1,
      model: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'prepare', name: 'prepare_program', arguments: {} }],
        },
      ],
    },
    {
      id: 2,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'prepare',
          toolName: 'prepare_program',
          isError: true,
          content: [{ type: 'text', text: 'Test case output differs from expected' }],
        },
      ],
    },
  ];
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({ json: { entries, pending: [], stopping: false } }),
  );
  await page.goto('/tests/browser/chat.html');
  await expect(
    page.getByRole('button', { name: '执行失败: 准备计算程序', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '已完成: 准备计算程序', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText('Test case output differs from expected', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: '执行失败: 准备计算程序', exact: true }),
  ).toBeVisible();
});

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

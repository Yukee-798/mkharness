import { test, expect } from '@playwright/test';

test('generation diagnostics stay internal while a terminal failure uses product language', async ({
  page,
}) => {
  const entries = [
    {
      id: 1,
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will prepare a compute program and compare expected values.' },
            { type: 'toolCall', id: 'prepare', name: 'prepare_program', arguments: {} },
          ],
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
    {
      id: 3,
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'ui', name: 'present_openui', arguments: { ui: 'invalid' } },
          ],
        },
      ],
    },
    {
      id: 4,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'ui',
          toolName: 'present_openui',
          isError: true,
          content: [{ type: 'text', text: 'Invalid OpenUI: unresolved recipeForm' }],
        },
      ],
    },
    {
      id: 5,
      model: [
        {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Program/UI repair limit reached (initial attempt plus two repairs).',
        },
      ],
    },
  ];
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({ json: { entries, pending: [], stopping: false } }),
  );
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByRole('alert')).toHaveText(
    '交互界面暂时无法生成。你可以重新发送需求再试一次。',
  );
  await expect(
    page.getByText('Test case output differs from expected', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('I will prepare a compute program and compare expected values.', {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Invalid OpenUI: unresolved recipeForm', { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /准备计算程序|复制回答/ })).toHaveCount(0);
  await expect(page.getByText('正在生成交互界面…', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('alert')).toHaveText(
    '交互界面暂时无法生成。你可以重新发送需求再试一次。',
  );
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
  await expect(page.getByRole('button', { name: '复制回答', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制代码', exact: true })).toBeVisible();
  const input = page.getByLabel('消息', { exact: true });
  await input.fill('hello');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('hello\n');
  expect(submitted).toHaveLength(0);
  await input.press('Enter');
  await expect.poll(() => submitted.length).toBe(1);
  await expect(input).toHaveValue('');
});

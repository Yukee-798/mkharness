import { snapshotFixture } from './chat-fixtures';
import { test, expect, resource } from './fixtures';

test('generation diagnostics stay internal while a terminal failure uses product language', async ({
  page,
}) => {
  const entries = [
    {
      conversationId: 1,
      kind: 'pi.assistant',
      id: 1,
      model: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'prepare', name: 'prepare_program', arguments: {} }],
        },
      ],
    },
    {
      conversationId: 1,
      kind: 'pi.tool-result',
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
      conversationId: 1,
      kind: 'pi.assistant',
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
      conversationId: 1,
      kind: 'pi.tool-result',
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
  ];
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({ json: snapshotFixture({ entries, pending: [], stopping: false }) }),
  );
  await page.goto('/tests/browser/chat.html');
  // The first full-suite browser also loads the optional OpenUI module before this product state.
  await expect(page.getByRole('alert')).toHaveText('内容暂时无法生成。可以调整需求再试一次。', {
    timeout: 10_000,
  });
  await expect(
    page.getByText('Test case output differs from expected', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Invalid OpenUI: unresolved recipeForm', { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /准备计算程序|复制回答/ })).toHaveCount(0);
  await expect(page.getByText('正在生成交互界面…', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('alert')).toHaveText('内容暂时无法生成。可以调整需求再试一次。');
});

test('assistant markdown renders semantically and keyboard composition submits once over HTTP', async ({
  page,
}) => {
  const submitted: unknown[] = [];
  const entries = [
    {
      conversationId: 1,
      kind: 'pi.assistant',
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
    return route.fulfill({ json: snapshotFixture({ entries, pending: [], stopping: false }) });
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

test('unresolved generated-content failure stays visible after the next user message', async ({
  page,
}) => {
  let next = false;
  const entries = () => [
    {
      conversationId: 1,
      kind: 'pi.assistant',
      id: 1,
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
      conversationId: 1,
      kind: 'pi.tool-result',
      id: 2,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'ui',
          toolName: 'present_openui',
          content: [{ type: 'text', text: 'Invalid OpenUI' }],
          isError: true,
        },
      ],
    },
    ...(next
      ? [
          {
            conversationId: 1,
            kind: 'app.input',
            id: 3,
            model: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          },
          {
            conversationId: 1,
            kind: 'pi.assistant',
            id: 4,
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Next answer.' }] }],
          },
        ]
      : []),
  ];
  await page.route('**/api/conversations/**', (route) => {
    if (route.request().method() === 'POST') {
      next = true;
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    return route.fulfill({
      json: snapshotFixture({ entries: entries(), pending: [], stopping: false }),
    });
  });
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByRole('alert')).toContainText('内容暂时无法生成');
  await page.getByLabel('消息', { exact: true }).fill('hello');
  await page.getByLabel('消息', { exact: true }).press('Enter');
  await expect(page.getByText('Next answer.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('内容暂时无法生成');
});

test('a no-result native fault replaces the inert generated-content preview with a terminal failure', async ({
  page,
}) => {
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({
      json: snapshotFixture({
        entries: [
          {
            conversationId: 1,
            kind: 'pi.assistant',
            id: 1,
            model: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'ui',
                    name: 'present_openui',
                    arguments: { ui: 'root = Stack([Text("text","Inert preview")])' },
                  },
                ],
              },
            ],
          },
        ],
        toolProgress: { '1.ui': { status: 'failed' } },
        pending: [],
        stopping: false,
      }),
    }),
  );
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByRole('alert')).toContainText('内容暂时无法生成');
  await expect(page.getByText('Inert preview', { exact: true })).toHaveCount(0);
});

test('a later publication repairs errors only within its own response', async ({ page }) => {
  const ui = 'root = Stack([Text("text","Repaired answer")])';
  await page.route('**/api/conversations/**', (route) => {
    if (route.request().url().includes('/extensions/openui/resources/'))
      return route.fulfill({
        json: resource({ panelRef: '3.ui', ui, program: null, revision: 0 }),
      });
    return route.fulfill({
      json: snapshotFixture({
        entries: [
          {
            conversationId: 1,
            kind: 'pi.assistant',
            id: 1,
            model: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'bad',
                    name: 'present_openui',
                    arguments: { ui: 'invalid' },
                  },
                ],
              },
            ],
          },
          {
            conversationId: 1,
            kind: 'pi.tool-result',
            id: 2,
            model: [
              {
                role: 'toolResult',
                toolCallId: 'bad',
                toolName: 'present_openui',
                content: [{ type: 'text', text: 'Invalid OpenUI' }],
                isError: true,
              },
            ],
          },
          {
            conversationId: 1,
            kind: 'pi.assistant',
            id: 3,
            model: [
              {
                role: 'assistant',
                content: [
                  { type: 'toolCall', id: 'ui', name: 'present_openui', arguments: { ui } },
                ],
              },
            ],
          },
          {
            conversationId: 1,
            kind: 'pi.tool-result',
            id: 4,
            model: [
              {
                role: 'toolResult',
                toolCallId: 'ui',
                toolName: 'present_openui',
                content: [{ type: 'text', text: '{"panelRef":"3.ui"}' }],
                isError: false,
              },
            ],
          },
        ],
        pending: [],
        stopping: false,
      }),
    });
  });
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByText('Repaired answer', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

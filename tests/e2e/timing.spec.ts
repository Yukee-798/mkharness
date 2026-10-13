import { createServer } from 'node:http';
import { test, expect } from './fixtures';
import { toMessages } from '../../src/shared/stream';

test('decorates an existing tool and one reply footer through stream, commit and reload', async ({
  page,
}) => {
  const runId = '11111111-1111-4111-8111-111111111111';
  const toolMessage = `draft:${runId}:1`,
    answerMessage = `draft:${runId}:2`;
  const entries: any[] = [
    { id: 1, model: [{ role: 'user', content: '读取网页' }] },
    {
      id: 2,
      model: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call',
              name: 'read_web',
              arguments: { url: 'https://example.com' },
            },
          ],
        },
      ],
    },
    {
      id: 3,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call',
          toolName: 'read_web',
          content: [{ type: 'text', text: 'Retrieved source' }],
        },
      ],
    },
    { id: 4, model: [{ role: 'assistant', content: [{ type: 'text', text: '这是最终回复。' }] }] },
  ];
  const timing = {
    tools: { '2.call': { startedAt: 1000, endedAt: 1842 } },
    replies: { '4': { runId, startedAt: 1000, endedAt: 3500 } },
  };
  let finished = false,
    attachments = 0,
    mutations = 0,
    finish = () => {};
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Access-Control-Allow-Origin': '*',
    });
    const emit = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'RUN_STARTED', threadId: 'a', runId });
    emit({
      type: 'STATE_SNAPSHOT',
      snapshot: { runId, status: 'placed', extensionState: { timing: { tools: {}, replies: {} } } },
    });
    emit({ type: 'TEXT_MESSAGE_START', messageId: toolMessage, role: 'assistant' });
    emit({
      type: 'TOOL_CALL_START',
      toolCallId: `${toolMessage}.call`,
      toolCallName: 'read_web',
      parentMessageId: toolMessage,
    });
    emit({
      type: 'TOOL_CALL_ARGS',
      toolCallId: `${toolMessage}.call`,
      delta: '{"url":"https://example.com"}',
    });
    emit({ type: 'TOOL_CALL_END', toolCallId: `${toolMessage}.call` });
    finish = () => {
      finished = true;
      emit({ type: 'TEXT_MESSAGE_END', messageId: toolMessage });
      emit({ type: 'TEXT_MESSAGE_START', messageId: answerMessage, role: 'assistant' });
      emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: answerMessage, delta: '这是最终回复。' });
      emit({ type: 'TEXT_MESSAGE_END', messageId: answerMessage });
      emit({
        type: 'MESSAGES_SNAPSHOT',
        messages: toMessages(
          entries,
          new Map([
            ['2', toolMessage],
            ['4', answerMessage],
          ]),
        ),
      });
      emit({
        type: 'STATE_SNAPSHOT',
        snapshot: {
          runId,
          status: 'done',
          messageIds: { '2': toolMessage, '4': answerMessage },
          extensionState: { timing },
        },
      });
      emit({ type: 'RUN_FINISHED', threadId: 'a', runId });
      response.end();
    };
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await page.route('**/api/capabilities', (route) =>
      route.fulfill({ json: { extensionIds: ['web', 'timing'] } }),
    );
    await page.route('**/api/conversations/**', (route) => {
      if (route.request().method() !== 'GET') mutations++;
      if (new URL(route.request().url()).pathname.endsWith('/events')) {
        attachments++;
        return route.continue({ url: `http://127.0.0.1:${port}/events` });
      }
      return route.fulfill({
        json: {
          entries: finished ? entries : [],
          pending: finished ? [] : [{ operationId: runId, status: 'running' }],
          stopping: false,
          extensionState: { timing: finished ? timing : { tools: {}, replies: {} } },
        },
      });
    });
    await page.goto('/tests/browser/chat.html');
    const tool = page.locator('[data-slot="tool-call"]').first();
    await expect(tool).toContainText('正在读取网页');
    await tool.getByRole('button').first().click();
    await expect(tool.getByText('请求参数', { exact: true })).toBeVisible();
    expect(await page.locator('[data-slot="assistant-footer"]').count()).toBe(0);
    const input = await page.getByLabel('消息', { exact: true }).elementHandle();
    await page.getByLabel('消息', { exact: true }).fill('Keep my draft');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Keep my draft');
    expect(await input!.evaluate((element) => element.isConnected)).toBe(true);
    expect(attachments).toBe(1);
    finish();
    await expect(page.locator('[data-slot="tool-duration"]')).toHaveText('842 ms');
    await expect(page.locator('[data-slot="assistant-footer"]')).toHaveCount(1);
    await expect(page.locator('[data-slot="reply-duration"]')).toContainText('回复耗时 2.5 s');
    await expect(page.locator('[data-slot="reply-duration"]')).not.toContainText('SSE');
    await expect(tool.getByText('请求参数', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: '导出为 Markdown' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.md$/);
    await page.mouse.click(1100, 450);
    await page.screenshot({ path: '/tmp/agent-timing-footer.png' });
    await page.reload();
    await expect(page.locator('[data-slot="tool-duration"]')).toHaveText('842 ms');
    await expect(page.locator('[data-slot="reply-duration"]')).toContainText('回复耗时 2.5 s');
    await expect(page.locator('[data-slot="reply-duration"]')).not.toContainText('SSE');
    expect(attachments).toBe(1);
    expect(mutations).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('removing timing leaves the original tool, native footer and idle runtime intact', async ({
  page,
}) => {
  const loaded: string[] = [];
  let attachments = 0;
  page.on('request', (request) => loaded.push(request.url()));
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ json: { extensionIds: ['web'] } }),
  );
  await page.route('**/api/conversations/**', (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/events')) attachments++;
    return route.fulfill({
      json: {
        pending: [],
        stopping: false,
        entries: [
          { id: 1, model: [{ role: 'user', content: 'Read a page' }] },
          {
            id: 2,
            model: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'toolCall',
                    id: 'call',
                    name: 'read_web',
                    arguments: { url: 'https://example.com' },
                  },
                ],
              },
            ],
          },
          {
            id: 3,
            model: [
              {
                role: 'toolResult',
                toolCallId: 'call',
                toolName: 'read_web',
                content: [{ type: 'text', text: 'Original result' }],
              },
            ],
          },
          {
            id: 4,
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Original reply' }] }],
          },
        ],
      },
    });
  });
  await page.goto('/tests/browser/chat.html');
  const tool = page.locator('[data-slot="tool-call"]').first();
  await expect(tool).toContainText('已读取网页');
  await tool.getByRole('button').first().click();
  await expect(tool.getByText('Original result', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制回复', exact: true })).toBeVisible();
  await expect(
    page.locator('[data-slot="tool-duration"], [data-slot="reply-duration"]'),
  ).toHaveCount(0);
  await page.getByLabel('消息', { exact: true }).fill('Still editable');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Still editable');
  await expect(tool.getByText('Original result', { exact: true })).toBeVisible();
  expect(attachments).toBe(0);
  expect(loaded.some((url) => /extensions\/timing\//.test(url))).toBe(false);
});

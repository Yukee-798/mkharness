import { test, expect } from '@playwright/test';

test('tool rows have the same spacing within and across Pi messages, including failures', async ({
  page,
}) => {
  const call = (id: string, name = 'read_web') => ({
    type: 'toolCall',
    id,
    name,
    arguments: name === 'search_web' ? { query: '市场趋势' } : { url: 'https://example.com/data' },
  });
  const result = (entryId: number, id: string, isError = false) => ({
    id: entryId,
    model: [
      {
        role: 'toolResult',
        toolCallId: id,
        toolName: 'read_web',
        isError,
        content: [{ type: 'text', text: isError ? 'Service unavailable' : 'Source retrieved' }],
      },
    ],
  });
  const entries = [
    {
      id: 1,
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '我会核对来源并比较结果。' }, call('one'), call('two')],
        },
      ],
    },
    result(2, 'one'),
    result(3, 'two'),
    {
      id: 4,
      model: [{ role: 'assistant', content: [call('three'), call('hidden', 'prepare_program')] }],
    },
    result(5, 'three'),
    { id: 6, model: [{ role: 'assistant', content: [call('four', 'search_web')] }] },
    result(7, 'four', true),
    { id: 8, model: [{ role: 'assistant', content: [{ type: 'text', text: '这是比较结果。' }] }] },
  ];
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({ json: { entries, pending: [], stopping: false } }),
  );
  await page.goto('/tests/browser/chat.html');
  const rows = page.locator('[data-slot="tool-fallback-trigger"]');
  await expect(rows).toHaveCount(4);
  const boxes = await rows.evaluateAll((elements) =>
    elements.map((e) => {
      const b = e.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, height: b.height };
    }),
  );
  for (const box of boxes) expect(box.height).toBe(boxes[0].height);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].top - boxes[i - 1].bottom).toBe(8);
  await expect(page.getByText('read_web', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Service unavailable', { exact: true })).toHaveCount(0);
  const failure = page.getByRole('button', { name: '执行失败：搜索网页 · 市场趋势', exact: true });
  await failure.focus();
  await failure.press('Enter');
  await expect(failure).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Service unavailable', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('reasoning streams before the answer, finishes honestly and survives history reload', async ({
  page,
}) => {
  const { createServer } = await import('node:http');
  const runId = '11111111-1111-4111-8111-111111111111';
  let finish = () => {},
    committed = false;
  const entries = [
    {
      id: 2,
      model: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '先核对来源，再比较差异。',
              thinkingSignature: 'private-signature',
            },
            { type: 'thinking', thinking: 'private-encrypted-content', redacted: true },
            { type: 'text', text: '这是最终比较结果。' },
          ],
        },
      ],
    },
  ];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    const emit = (event: any) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'RUN_STARTED', threadId: 'a', runId });
    emit({ type: 'REASONING_MESSAGE_START', messageId: 'thinking', role: 'reasoning' });
    emit({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'thinking', delta: '先核对来源' });
    finish = () => {
      committed = true;
      emit({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'thinking', delta: '，再比较差异。' });
      emit({ type: 'REASONING_MESSAGE_END', messageId: 'thinking' });
      emit({ type: 'TEXT_MESSAGE_START', messageId: 'answer', role: 'assistant' });
      emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: '这是最终比较结果。' });
      emit({ type: 'TEXT_MESSAGE_END', messageId: 'answer' });
      emit({ type: 'RUN_FINISHED', threadId: 'a', runId });
      res.end();
    };
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await page.route('**/api/conversations/**', (route) => {
      if (route.request().url().endsWith('/events'))
        return route.continue({ url: `http://127.0.0.1:${port}/events` });
      return route.fulfill({
        json: {
          entries: committed ? entries : [],
          pending: committed ? [] : [{ operationId: runId, status: 'running' }],
          stopping: false,
        },
      });
    });
    await page.goto('/tests/browser/chat.html');
    await expect(page.getByRole('button', { name: '正在思考…', exact: true })).toBeVisible();
    await expect(page.getByText('先核对来源', { exact: true })).toBeVisible();
    await expect(page.getByText('这是最终比较结果。', { exact: true })).toHaveCount(0);
    finish();
    await expect(page.getByText('这是最终比较结果。', { exact: true })).toBeVisible();
    const disclosure = page.getByRole('button', { name: '思考过程', exact: true });
    await expect(disclosure).toHaveCount(1);
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.click();
    await expect(page.getByText('先核对来源，再比较差异。', { exact: true })).toBeVisible();
    await expect(page.getByText('private-encrypted-content', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(disclosure).toHaveCount(1);
    await disclosure.click();
    await expect(page.getByText('先核对来源，再比较差异。', { exact: true })).toBeVisible();
    await expect(page.getByText('这是最终比较结果。', { exact: true })).toHaveCount(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('disconnect recovery preserves the viewport and draft and never submits another task', async ({
  page,
}) => {
  const { createServer } = await import('node:http');
  const runId = '11111111-1111-4111-8111-111111111111';
  const entries = [
    { id: 1, model: [{ role: 'assistant', content: [{ type: 'text', text: '已保留的回复。' }] }] },
  ];
  let drop = () => {},
    finish = () => {},
    observations = 0,
    posts = 0,
    snapshots = 0,
    committed = false,
    release = () => {};
  const allowRestore = new Promise<void>((resolve) => (release = resolve));
  const server = createServer((_req, res) => {
    observations++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    res.write(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'a', runId })}\n\n`);
    if (observations === 1) drop = () => res.end();
    else
      finish = () => {
        committed = true;
        res.end(`data: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: 'a', runId })}\n\n`);
      };
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await page.route('**/api/conversations/**', async (route) => {
      if (route.request().method() === 'POST') posts++;
      if (route.request().url().endsWith('/events'))
        return route.continue({ url: `http://127.0.0.1:${port}/events` });
      snapshots++;
      if (snapshots === 2) await allowRestore;
      return route.fulfill({
        json: {
          entries,
          pending: committed ? [] : [{ operationId: runId, status: 'running' }],
          stopping: false,
        },
      });
    });
    await page.goto('/tests/browser/chat.html');
    await expect.poll(() => observations).toBe(1);
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('未发送的问题');
    const nodes = await Promise.all([
      page.locator('[data-slot="chat-viewport"]').elementHandle(),
      composer.elementHandle(),
    ]);
    drop();
    await expect(page.getByText('正在重新连接…', { exact: true })).toBeVisible();
    await expect(page.getByText('已保留的回复。', { exact: true })).toBeVisible();
    await expect.poll(() => snapshots).toBe(2);
    for (const node of nodes)
      expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    release();
    await expect.poll(() => observations).toBe(2);
    await expect(page.getByText('已恢复连接', { exact: true })).toBeVisible();
    await expect(composer).toHaveValue('未发送的问题');
    await expect(composer).toBeFocused();
    expect(posts).toBe(0);
    for (const node of nodes)
      expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    finish();
    await expect(page.getByText('任务运行中', { exact: true })).toHaveCount(0);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

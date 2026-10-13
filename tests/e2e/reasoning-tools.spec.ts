import { test, expect, type Locator } from './fixtures';

async function expectShimmer(label: Locator) {
  await expect(label).toBeVisible();
  const initialTime = await label.evaluate((element) => {
    const animation = element
      .getAnimations({ subtree: true })
      .find((item) => item.effect?.getTiming().iterations === Infinity);
    return Number(animation?.currentTime ?? 0);
  });
  await expect
    .poll(() =>
      label.evaluate(
        (element, start) =>
          element
            .getAnimations({ subtree: true })
            .some(
              (item) =>
                item.effect?.getTiming().iterations === Infinity &&
                item.playState === 'running' &&
                Number(item.currentTime) > start + 40,
            ),
        initialTime,
      ),
    )
    .toBe(true);
}

test('tool rows have consistent spacing within a group and between standalone Pi messages', async ({
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
  const rows = page.locator('[data-slot="tool-call"] > button');
  await expect(rows).toHaveCount(4);
  await expect
    .poll(() =>
      page
        .locator('[data-slot="tool-group-content"]')
        .first()
        .evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === 'running'),
        ),
    )
    .toBe(false);
  const boxes = await rows.evaluateAll((elements) =>
    elements.map((e) => {
      const b = e.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, height: b.height };
    }),
  );
  for (const box of boxes) expect(box.height).toBeCloseTo(boxes[0].height, 3);
  expect(boxes[1].top - boxes[0].bottom).toBeCloseTo(8, 3);
  expect(boxes[3].top - boxes[2].bottom).toBeCloseTo(8, 3);
  await expect(page.getByRole('button', { name: '已调用 2 个工具', exact: true })).toHaveCount(1);
  await expect(page.getByText('read_web', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Service unavailable', { exact: true })).toHaveCount(0);
  const failure = page.getByRole('button', { name: '网页搜索失败 · 市场趋势', exact: true });
  await failure.focus();
  await failure.press('Enter');
  await expect(failure).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() =>
      failure
        .locator('[data-slot="tool-call-chevron"]')
        .evaluate((element) => getComputedStyle(element).rotate),
    )
    .toBe('90deg');
  await expect(failure.locator('.lucide-check')).toHaveCount(0);
  await expect(failure.locator('.lucide-circle-x')).toHaveCount(1);
  expect(
    await page
      .locator('[data-slot="tool-fallback-content"][data-state="open"]')
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('collapsible-down');
  await expect(page.getByText('Service unavailable', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('collapsed reasoning, tool groups and single tools share spacing across Pi message boundaries', async ({
  page,
}) => {
  const thinking = { type: 'thinking', thinking: '核对来源与关键假设。' };
  const call = (id: string, name = 'read_web') => ({
    type: 'toolCall',
    id,
    name,
    arguments: { url: 'https://example.com/data' },
  });
  const assistant = (id: number, content: unknown[]) => ({
    id,
    model: [{ role: 'assistant', content }],
  });
  const entries = [
    assistant(1, [thinking, call('one'), call('two')]),
    assistant(2, [thinking, call('three'), call('hidden', 'prepare_program')]),
    assistant(3, [thinking]),
    // Internal publication messages must not leave empty spacing between traces.
    assistant(4, [call('hidden-again', 'prepare_program')]),
    assistant(5, [thinking]),
    assistant(6, [{ type: 'text', text: '这是最终结论。' }]),
  ];
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({ json: { entries, pending: [], stopping: false } }),
  );
  await page.goto('/tests/browser/chat.html');
  await expect(
    page.getByRole('button', { name: '等待处理 · example.com', exact: true }),
  ).toHaveCount(3);
  const group = page.getByRole('button', { name: '已调用 2 个工具', exact: true });
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(group.locator('..').locator('[data-slot="tool-group-content"]')).not.toBeVisible();
  const rows = page.locator(
    '[data-slot="reasoning-trigger"], [data-slot="tool-group-trigger"], [data-slot="tool-call"] > button:visible',
  );
  await expect(rows).toHaveCount(6);
  const expectEqualSpacing = async () => {
    const boxes = await rows.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      }),
    );
    for (const box of boxes) expect(box.height).toBeCloseTo(boxes[0].height, 3);
    for (let i = 1; i < boxes.length; i++)
      expect(boxes[i].top - boxes[i - 1].bottom).toBeCloseTo(8, 3);
  };
  await expectEqualSpacing();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectEqualSpacing();
  // Opening and closing an official reasoning disclosure must restore the same layout.
  const reasoning = page.getByRole('button', { name: '思考过程', exact: true }).first();
  await reasoning.click();
  await expect(page.getByText(thinking.thinking, { exact: true })).toBeVisible();
  await reasoning.click();
  await expect(page.locator('[data-slot="reasoning-content"]').first()).not.toBeVisible();
  await expectEqualSpacing();
  await expect(page.getByText('Preparing a computation program.', { exact: true })).toHaveCount(0);
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
    const shimmer = page
      .getByRole('button', { name: '正在思考…', exact: true })
      .locator('.shimmer');
    await expectShimmer(shimmer);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect
      .poll(() =>
        shimmer.evaluate((element) =>
          element.getAnimations({ subtree: true }).some((item) => item.playState === 'running'),
        ),
      )
      .toBe(false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByText('先核对来源', { exact: true })).toBeVisible();
    await expect(page.getByText('这是最终比较结果。', { exact: true })).toHaveCount(0);
    finish();
    await expect(page.getByText('这是最终比较结果。', { exact: true })).toBeVisible();
    const disclosure = page.getByRole('button', { name: '思考过程', exact: true });
    await expect(disclosure).toHaveCount(1);
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.click();
    await expect
      .poll(() =>
        disclosure
          .locator('[data-slot="disclosure-chevron"]')
          .evaluate((element) => getComputedStyle(element).rotate),
      )
      .toBe('90deg');
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

test('official tool call shows live shimmer and changes its status only after completion', async ({
  page,
}) => {
  const { createServer } = await import('node:http');
  const runId = '11111111-1111-4111-8111-111111111111';
  let finish = () => {},
    committed = false;
  const entries = [
    {
      id: 1,
      model: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'lookup',
              name: 'search_web',
              arguments: { query: 'draft persistence' },
            },
          ],
        },
      ],
    },
    {
      id: 2,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'lookup',
          toolName: 'search_web',
          content: [{ type: 'text', text: '3 matches' }],
        },
      ],
    },
  ];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'RUN_STARTED', threadId: 'a', runId });
    emit({
      type: 'TOOL_CALL_START',
      toolCallId: 'lookup',
      toolCallName: 'search_web',
      parentMessageId: 'tool-message',
    });
    emit({ type: 'TOOL_CALL_ARGS', toolCallId: 'lookup', delta: '{"query":"draft persistence"}' });
    emit({ type: 'TOOL_CALL_END', toolCallId: 'lookup' });
    finish = () => {
      committed = true;
      emit({
        type: 'TOOL_CALL_RESULT',
        messageId: 'lookup-result',
        toolCallId: 'lookup',
        content: '3 matches',
        role: 'tool',
      });
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
    const tool = page.locator('[data-slot="tool-call"]');
    await expect(
      page.getByRole('button', { name: '正在搜索网页 · draft persistence', exact: true }),
    ).toBeVisible();
    await expectShimmer(tool.locator('.shimmer'));
    await expect(tool.locator('.lucide-check')).toHaveCount(0);
    finish();
    const done = page.getByRole('button', { name: '已搜索网页 · draft persistence', exact: true });
    await expect(done).toBeVisible();
    await expect(tool.locator('.shimmer')).toHaveCount(0);
    await expect(tool.locator('.lucide-search')).toHaveCount(1);
    await expect(tool.locator('.lucide-circle-x')).toHaveCount(0);
    await done.click();
    await expect(tool.getByText('3 matches', { exact: true })).toBeVisible();
    await expect(tool.getByText('{"query":"draft persistence"}', { exact: true })).toBeVisible();
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

test('official grouped tools bound each payload and support internal keyboard scrolling on desktop and mobile', async ({
  page,
}) => {
  const data = 'source-row '.repeat(1500) + 'end-of-payload';
  const entries = [
    {
      id: 1,
      model: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'one',
              name: 'read_web',
              arguments: { url: 'https://example.com/data', notes: data },
            },
            { type: 'toolCall', id: 'two', name: 'search_web', arguments: { query: 'sources' } },
            { type: 'toolCall', id: 'internal', name: 'prepare_program', arguments: {} },
          ],
        },
      ],
    },
    {
      id: 2,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'one',
          toolName: 'read_web',
          content: [{ type: 'text', text: data }],
        },
      ],
    },
    {
      id: 3,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'two',
          toolName: 'search_web',
          content: [{ type: 'text', text: 'Found two sources' }],
        },
      ],
    },
  ];
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({ json: { entries, pending: [], stopping: false } }),
  );
  await page.goto('/tests/browser/chat.html');
  const group = page.getByRole('button', { name: '已调用 2 个工具', exact: true });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  const tool = page.getByRole('button', { name: '已读取网页 · example.com', exact: true });
  await tool.click();
  const request = page.getByRole('region', { name: '请求参数内容', exact: true });
  const result = page.getByRole('region', { name: '工具结果内容', exact: true });
  for (const region of [request, result]) {
    await expect(region).toBeVisible();
    await expect(region).toContainText('end-of-payload');
    const size = await region.evaluate((element) => ({
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
      overflow: getComputedStyle(element).overflowY,
    }));
    expect(size.height).toBeLessThanOrEqual(256);
    expect(size.contentHeight).toBeGreaterThan(size.height);
    expect(size.overflow).toBe('auto');
    await region.focus();
    const viewportTop = await page
      .locator('[data-slot="chat-viewport"]')
      .evaluate((element) => element.scrollTop);
    await region.press('PageDown');
    await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(
      await page.locator('[data-slot="chat-viewport"]').evaluate((element) => element.scrollTop),
    ).toBe(viewportTop);
  }
  await group.focus();
  await group.press('Enter');
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(tool).not.toBeVisible();
  await group.press('Enter');
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(tool).toHaveAttribute('aria-expanded', 'false');
  await tool.click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const region of [request, result]) {
    await expect
      .poll(() => region.evaluate((element) => element.clientHeight))
      .toBeLessThanOrEqual(176);
    expect(await region.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

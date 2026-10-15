import { resource } from './fixtures';
import { test, expect } from './fixtures';
test('refresh, switching and three queued tasks only attach; a completed chat never submits again', async ({
  page,
}) => {
  let submissions = 0,
    observations = 0;
  const pending: { operationId: string; status: string }[] = [];
  const entries: any[] = [];
  let nextEntry = 1;
  await page.route('**/api/conversations/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const chat = url.pathname.split('/')[3];
    if (url.pathname.endsWith('/runs') && method === 'POST') {
      submissions++;
      const c = route.request().postDataJSON();
      pending.push({ operationId: c.runId, status: pending.length ? 'queued' : 'running' });
      await route.fulfill({ status: 202, json: { runId: c.runId, accepted: true } });
      return;
    }
    if (url.pathname.endsWith('/snapshot')) {
      await route.fulfill({
        json: {
          entries: chat === 'a' ? entries : [],
          pending: chat === 'a' ? pending : [],
          stopping: false,
        },
      });
      return;
    }
    if (url.pathname.endsWith('/events')) {
      observations++;
      const runId = url.pathname.split('/')[5];
      await new Promise((r) => setTimeout(r, 600));
      const selected = pending.find((p) => p.operationId === runId);
      if (selected) {
        entries.push(
          { id: nextEntry++, model: [{ role: 'user', content: 'message' }] },
          {
            id: nextEntry++,
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'completed ' + runId }] }],
          },
        );
        pending.splice(pending.indexOf(selected), 1);
        if (pending[0]) pending[0].status = 'running';
      }
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: chat, runId })}\n\ndata: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: chat, runId })}\n\n`,
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
  });
  await page.goto('/tests/browser/chat.html');
  for (const text of ['first', 'second', 'third']) {
    await page.getByLabel('消息', { exact: true }).fill(text);
    // The single composer button stops active work; Enter still queues messages.
    if (text === 'first') await page.getByRole('button', { name: '发送', exact: true }).click();
    else await page.getByLabel('消息', { exact: true }).press('Enter');
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
  }
  expect(submissions).toBe(3);
  await page.reload();
  await page.getByRole('button', { name: '切换聊天' }).click();
  await page.getByRole('button', { name: '切换聊天' }).click();
  await expect.poll(() => pending.length, { timeout: 15000 }).toBe(0);
  await expect(page.getByText('completed', { exact: false })).toHaveCount(3);
  const count = submissions;
  await page.reload();
  await expect(page.getByText('completed', { exact: false })).toHaveCount(3);
  expect(submissions).toBe(count);
  expect(observations).toBeGreaterThanOrEqual(3);
});

test('one composer action switches from send to stop without a running banner', async ({
  page,
}) => {
  let pending = false,
    stopping = false,
    submissions = 0,
    stops = 0;
  let releaseStop = () => {};
  const stopResponse = new Promise<void>((resolve) => (releaseStop = resolve));
  let finish = () => {};
  const completed = new Promise<void>((resolve) => (finish = resolve));
  const runId = '11111111-1111-4111-8111-111111111111';
  await page.route('**/api/conversations/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/runs')) {
      submissions++;
      pending = true;
      return route.fulfill({ status: 202, json: { runId, accepted: true } });
    }
    if (path.endsWith('/snapshot'))
      return route.fulfill({
        json: {
          entries: [],
          pending: pending ? [{ operationId: runId, status: 'running' }] : [],
          stopping,
        },
      });
    if (path.endsWith('/stop')) {
      stops++;
      await stopResponse;
      stopping = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/events')) {
      await completed;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'a', runId })}\n\ndata: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: 'a', runId })}\n\n`,
      });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
  });
  try {
    await page.goto('/tests/browser/chat.html');
    const input = page.getByLabel('消息', { exact: true });
    // Count execution controls; the independent image picker is also a form button.
    const action = page.getByRole('button', { name: /^(发送|停止并撤回排队|正在停止…|提交中…)$/ });
    await input.fill('Start a task');
    await expect(action).toHaveCount(1);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const stop = page.getByRole('button', { name: '停止并撤回排队', exact: true });
    await expect(stop).toBeEnabled();
    await expect(action).toHaveCount(1);
    await expect(page.locator('[data-slot="connection-status"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
    await input.fill('Keep this draft');
    await stop.click();
    await expect(page.getByRole('button', { name: '正在停止…', exact: true })).toBeDisabled();
    expect(stops).toBe(1);
    expect(submissions).toBe(1);
    releaseStop();
    await expect.poll(() => stopping).toBe(true);
    await expect(input).toBeDisabled();
    pending = stopping = false;
    finish();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
    await expect(input).toHaveValue('Keep this draft');
    await expect(action).toHaveCount(1);
    expect(stops).toBe(1);
    expect(submissions).toBe(1);
  } finally {
    releaseStop();
    finish();
  }
});

test('a genuine streaming response renders an inert native preview before the tool commits', async ({
  page,
}) => {
  const { createServer } = await import('node:http');
  let finish = () => {},
    reveal = () => {},
    started = false,
    committed = false;
  const ui =
    'root = Stack([Text("text","Streamed native preview"),Button("Analyze",Action([@ToAssistant("Analyze")]))])';
  const runId = '11111111-1111-4111-8111-111111111111';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    const emit = (event: any) => res.write('data: ' + JSON.stringify(event) + '\n\n');
    emit({ type: 'RUN_STARTED', threadId: 'a', runId });
    emit({
      type: 'TOOL_CALL_START',
      toolCallId: 'prepare-call',
      toolCallName: 'prepare_program',
      parentMessageId: 'preparation',
    });
    emit({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'prepare-call',
      delta: '{"code":"internal computation"}',
    });
    emit({
      type: 'TOOL_CALL_START',
      toolCallId: 'prepare-second',
      toolCallName: 'prepare_program',
      parentMessageId: 'preparation',
    });
    emit({
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'prepare-second',
      delta: '{"code":"second internal computation"}',
    });
    const prefix = JSON.stringify({
      ui: 'root = Stack([Text("text","Streamed native preview"),',
    }).slice(0, -2);
    reveal = () => {
      emit({ type: 'TOOL_CALL_END', toolCallId: 'prepare-call' });
      emit({ type: 'TOOL_CALL_END', toolCallId: 'prepare-second' });
      emit({
        type: 'TOOL_CALL_RESULT',
        toolCallId: 'prepare-call',
        messageId: 'prepared-result',
        content: '{"programRef":"1.prepare","initial":{"total":10}}',
      });
      emit({
        type: 'TOOL_CALL_RESULT',
        toolCallId: 'prepare-second',
        messageId: 'prepared-second-result',
        content: '{"programRef":"1.prepare-second","initial":{"total":20}}',
      });
      emit({
        type: 'TOOL_CALL_START',
        toolCallId: 'draft-call',
        toolCallName: 'present_openui',
        parentMessageId: 'draft',
      });
      emit({ type: 'TOOL_CALL_ARGS', toolCallId: 'draft-call', delta: prefix });
    };
    finish = () => {
      committed = true;
      const args = JSON.stringify({ ui });
      emit({ type: 'TOOL_CALL_ARGS', toolCallId: 'draft-call', delta: args.slice(prefix.length) });
      emit({ type: 'TOOL_CALL_END', toolCallId: 'draft-call' });
      emit({ type: 'RUN_FINISHED', threadId: 'a', runId });
      res.end();
    };
    started = true;
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  try {
    await page.route('**/api/conversations/**', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/capabilities'))
        return route.fulfill({ json: { extensionIds: ['web', 'openui', 'example'] } });
      if (url.endsWith('/events'))
        return route.continue({ url: `http://127.0.0.1:${port}/events` });
      if (url.includes('/extensions/openui/resources/'))
        return route.fulfill({
          json: resource({ panelRef: '2.call', ui, program: null, revision: 0 }),
        });
      if (url.endsWith('/snapshot'))
        return route.fulfill({
          json: {
            entries: committed
              ? [
                  {
                    id: 2,
                    model: [
                      {
                        role: 'assistant',
                        content: [
                          {
                            type: 'toolCall',
                            id: 'call',
                            name: 'present_openui',
                            arguments: { ui },
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
                        toolName: 'present_openui',
                        content: [{ type: 'text', text: '{"panelRef":"2.call","ready":true}' }],
                      },
                    ],
                  },
                ]
              : [],
            pending: committed ? [] : [{ operationId: runId, status: 'running' }],
            stopping: false,
          },
        });
      return route.fulfill({ status: 404 });
    });
    await page.goto('/tests/browser/chat.html');
    await expect.poll(() => started).toBe(true);
    // Internal preparation has no user-facing loading copy; native content still streams.
    await expect(page.getByText('正在生成交互界面…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('internal computation', { exact: false })).toHaveCount(0);
    reveal();
    await expect(page.getByText('Streamed native preview', { exact: true })).toBeVisible();
    expect(committed).toBe(false);
    expect(await page.locator('.generated-panel > div').getAttribute('inert')).not.toBeNull();
    finish();
    await expect(page.getByRole('button', { name: 'Analyze', exact: true })).toBeVisible();
    await expect(page.locator('.generated-panel > div')).not.toHaveAttribute('inert');
    await expect(page.getByText('正在生成交互界面…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '复制回答', exact: true })).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

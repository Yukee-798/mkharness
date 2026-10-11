import { test, expect } from './fixtures';
import { toMessages } from '../../src/shared/stream';

test('tool commits update live calls once; later reasoning and genuine repeated calls remain distinct', async ({
  page,
}) => {
  const { createServer } = await import('node:http');
  const runId = '11111111-1111-4111-8111-111111111111';
  const entries: any[] = [];
  const aliases = new Map<string, string>();
  let advance = () => {},
    finish = () => {},
    done = false;
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Access-Control-Allow-Origin': '*',
    });
    const emit = (event: any) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    const history = () =>
      emit({ type: 'MESSAGES_SNAPSHOT', messages: toMessages(entries, aliases) });
    const start = (draft: number, entryId: number, calls: any[]) => {
      const id = `draft:${runId}:${draft}`;
      aliases.set(String(entryId), id);
      emit({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' });
      emit({ type: 'REASONING_MESSAGE_START', messageId: `${id}:reasoning:0`, role: 'reasoning' });
      emit({
        type: 'REASONING_MESSAGE_CONTENT',
        messageId: `${id}:reasoning:0`,
        delta: '核对天气来源。',
      });
      emit({ type: 'REASONING_MESSAGE_END', messageId: `${id}:reasoning:0` });
      for (const call of calls) {
        const toolCallId = `${id}.${encodeURIComponent(call.id)}`;
        emit({ type: 'TOOL_CALL_START', toolCallId, toolCallName: call.name, parentMessageId: id });
        emit({ type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(call.arguments) });
        emit({ type: 'TOOL_CALL_END', toolCallId });
      }
      emit({ type: 'TEXT_MESSAGE_END', messageId: id });
      entries.push({
        id: entryId,
        model: [
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '核对天气来源。' }, ...calls],
          },
        ],
      });
      history();
    };
    const result = (id: number, call: any, isError = false) => {
      entries.push({
        id,
        model: [
          {
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            isError,
            content: [{ type: 'text', text: isError ? 'Search unavailable' : 'Weather retrieved' }],
          },
        ],
      });
      history();
    };
    const calls = [
      { type: 'toolCall', id: 'same', name: 'search_web', arguments: { query: '重庆天气' } },
      {
        type: 'toolCall',
        id: 'second',
        name: 'search_web',
        arguments: { query: 'Chongqing weather' },
      },
    ];
    const read = {
      type: 'toolCall',
      id: 'same',
      name: 'read_web',
      arguments: { url: 'https://wttr.in/Chongqing' },
    };
    emit({ type: 'RUN_STARTED', threadId: 'a', runId });
    history();
    start(1, 2, calls);
    result(3, calls[0], true);
    result(4, calls[1], true);
    start(2, 5, [read]);
    advance = () => {
      result(6, read);
      // Identical provider id and arguments are a real new call, not a duplicate rendering.
      start(3, 7, [calls[0]]);
      result(8, calls[0], true);
      emit({ type: 'TEXT_MESSAGE_START', messageId: `draft:${runId}:4`, role: 'assistant' });
      emit({ type: 'REASONING_MESSAGE_START', messageId: 'final-reasoning', role: 'reasoning' });
      emit({
        type: 'REASONING_MESSAGE_CONTENT',
        messageId: 'final-reasoning',
        delta: '整理天气结果。',
      });
    };
    finish = () => {
      done = true;
      entries.push({
        id: 9,
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '整理天气结果。' },
              { type: 'text', text: '这是天气结果。' },
            ],
          },
        ],
      });
      emit({ type: 'REASONING_MESSAGE_END', messageId: 'final-reasoning' });
      emit({
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: `draft:${runId}:4`,
        delta: '这是天气结果。',
      });
      emit({ type: 'TEXT_MESSAGE_END', messageId: `draft:${runId}:4` });
      emit({ type: 'RUN_FINISHED', threadId: 'a', runId });
      response.end();
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
          entries: done ? entries : [],
          pending: done ? [] : [{ operationId: runId, status: 'running' }],
          stopping: false,
        },
      });
    });
    await page.goto('/tests/browser/chat.html');
    const rows = page.locator('[data-slot="tool-call"] > button');
    await expect(rows).toHaveCount(3);
    await expect(
      page.getByRole('button', { name: '网页搜索失败 · 重庆天气', exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: /(?:正在读取网页|等待处理) · wttr\.in$/ }),
    ).toHaveCount(1);
    advance();
    await expect(rows).toHaveCount(4);
    await expect(
      page.getByRole('button', { name: '网页搜索失败 · 重庆天气', exact: true }),
    ).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: '已读取网页 · wttr.in', exact: true }),
    ).toHaveCount(1);
    await expect(page.getByRole('button', { name: '正在搜索网页', exact: false })).toHaveCount(0);
    finish();
    await expect(page.getByText('这是天气结果。', { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(4);
    await page.reload();
    await expect(rows).toHaveCount(4);
    await expect(
      page.getByRole('button', { name: '网页搜索失败 · 重庆天气', exact: true }),
    ).toHaveCount(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

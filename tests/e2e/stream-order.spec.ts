import { snapshotFixture } from './chat-fixtures';
import { resource } from './fixtures';
import { test, expect } from './fixtures';
import { toMessages } from '../../src/shared/stream';

for (const answer of ['text', 'openui'] as const) {
  test(`${answer} keeps reasoning and tool activity ahead of the answer through streaming, commit and reload`, async ({
    page,
  }) => {
    const { createServer } = await import('node:http');
    const runId = '11111111-1111-4111-8111-111111111111';
    const messageId = `draft:${runId}:1`;
    const ui = 'root = Stack([Text("text","逐步出现的生成内容")])';
    const calls =
      answer === 'openui'
        ? [{ type: 'toolCall', id: 'ui', name: 'present_openui', arguments: { ui } }]
        : ['one', 'two'].map((id) => ({
            type: 'toolCall',
            id,
            name: 'read_web',
            arguments: { url: `https://example.com/${id}` },
          }));
    const entries: any[] = [
      {
        conversationId: 1,
        kind: 'pi.assistant',
        id: 2,
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '核对数据与关键假设。' },
              ...(answer === 'text' ? [{ type: 'text', text: '逐步出现的正文' }] : []),
              ...calls,
            ],
          },
        ],
      },
      ...calls.map((call, index) => ({
        conversationId: 1,
        kind: 'pi.tool-result',
        id: index + 3,
        model: [
          {
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [
              {
                type: 'text',
                text: answer === 'openui' ? '{"panelRef":"2.ui","ready":true}' : 'Source retrieved',
              },
            ],
          },
        ],
      })),
    ];
    let commit = () => {},
      finish = () => {},
      committed = false,
      done = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': '*',
      });
      const emit = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({ type: 'RUN_STARTED', threadId: 'a', runId });
      emit({ type: 'MESSAGES_SNAPSHOT', messages: [] });
      // The same boundaries emitted by observeRun, including tool-only rounds.
      emit({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
      emit({
        type: 'REASONING_MESSAGE_START',
        messageId: `${messageId}:reasoning:0`,
        role: 'reasoning',
      });
      emit({
        type: 'REASONING_MESSAGE_CONTENT',
        messageId: `${messageId}:reasoning:0`,
        delta: '核对数据与关键假设。',
      });
      emit({ type: 'REASONING_MESSAGE_END', messageId: `${messageId}:reasoning:0` });
      if (answer === 'text')
        emit({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: '逐步出现的正文' });
      for (const call of calls) {
        const toolCallId = `${messageId}.${call.id}`;
        emit({
          type: 'TOOL_CALL_START',
          toolCallId,
          toolCallName: call.name,
          parentMessageId: messageId,
        });
        emit({ type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(call.arguments) });
        emit({ type: 'TOOL_CALL_END', toolCallId });
      }
      commit = () => {
        committed = true;
        emit({ type: 'TEXT_MESSAGE_END', messageId });
        emit({
          type: 'MESSAGES_SNAPSHOT',
          messages: toMessages(entries, new Map([['2', messageId]])),
        });
      };
      finish = () => {
        done = true;
        emit({ type: 'RUN_FINISHED', threadId: 'a', runId });
        response.end();
      };
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await page.route('**/api/conversations/**', (route) => {
        const url = route.request().url();
        if (url.endsWith('/capabilities'))
          return route.fulfill({ json: { extensionIds: ['web', 'openui', 'example'] } });
        if (new URL(url).pathname.endsWith('/events'))
          return route.continue({ url: `http://127.0.0.1:${port}/events` });
        if (url.includes('/extensions/openui/resources/'))
          return route.fulfill({
            json: resource({ panelRef: '2.ui', ui, program: null, revision: 0 }),
          });
        return route.fulfill({
          json: snapshotFixture({
            entries: committed ? entries : [],
            pending: done ? [] : [{ operationId: runId, status: 'running' }],
            stopping: false,
          }),
        });
      });
      await page.goto('/tests/browser/chat.html');
      const content = page.getByText(answer === 'text' ? '逐步出现的正文' : '逐步出现的生成内容', {
        exact: true,
      });
      await expect(content).toBeVisible();
      const sequence = () =>
        page
          .locator('[data-slot="assistant-message"]')
          .evaluateAll((messages) =>
            messages.flatMap((message) =>
              [
                ...message.querySelectorAll(
                  '[data-slot="reasoning-trigger"], [data-slot="tool-group-trigger"], .generated-panel, .aui-md',
                ),
              ]
                .filter((element) => !element.closest('[data-slot="reasoning-content"]'))
                .map((element) =>
                  element.matches('[data-slot="reasoning-trigger"]')
                    ? 'reasoning'
                    : element.matches('[data-slot="tool-group-trigger"]')
                      ? 'tools'
                      : 'content',
                ),
            ),
          );
      const expected =
        answer === 'text' ? ['reasoning', 'tools', 'content'] : ['reasoning', 'content'];
      await expect.poll(sequence).toEqual(expected);
      // Input and disclosure state also survive the committed snapshot.
      await page.getByLabel('消息', { exact: true }).fill('保留这份草稿');
      const reasoning = page.locator('[data-slot="reasoning-trigger"]');
      if ((await reasoning.getAttribute('aria-expanded')) === 'true') await reasoning.click();
      await reasoning.click();
      await expect(reasoning).toHaveAttribute('aria-expanded', 'true');
      commit();
      await expect(reasoning).toHaveAttribute('aria-expanded', 'true');
      await expect(content).toBeVisible();
      await expect.poll(sequence).toEqual(expected);
      await expect(page.getByLabel('消息', { exact: true })).toHaveValue('保留这份草稿');
      finish();
      await expect(page.getByRole('button', { name: '停止并撤回排队', exact: true })).toHaveCount(
        0,
      );
      await expect.poll(sequence).toEqual(expected);
      await page.reload();
      await expect(content).toBeVisible();
      await expect.poll(sequence).toEqual(expected);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

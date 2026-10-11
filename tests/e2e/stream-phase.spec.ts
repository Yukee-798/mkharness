import { resource } from './fixtures';
import { test, expect } from './fixtures';
import { DraftProjection, toMessages, toolResultEvent } from '../../src/shared/stream';

for (const answer of ['text', 'openui'] as const) {
  test(`${answer} stops the reasoning indicator during output, preserves late thinking and commits without remounting`, async ({
    page,
  }) => {
    const { createServer } = await import('node:http');
    const runId = '11111111-1111-4111-8111-111111111111';
    const messageId = `draft:${runId}:1`;
    let thinking = '核对数据。';
    let content = '逐步出现的内容';
    const ui = () => `root = Stack([Text("text","${content}${committed ? '")])' : ''}`;
    const draft = (withAnswer: boolean): any => ({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking },
        ...(withAnswer
          ? answer === 'text'
            ? [{ type: 'text', text: content }]
            : [{ type: 'toolCall', id: 'ui', name: 'present_openui', arguments: { ui: ui() } }]
          : []),
      ],
      api: 'openai-responses',
      provider: 'fixture',
      model: 'fixture',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: answer === 'text' ? 'stop' : 'toolUse',
      timestamp: 0,
    });
    const entries = (): any[] => [
      { id: 2, model: [draft(true)] },
      ...(answer === 'openui'
        ? [
            {
              id: 3,
              model: [
                {
                  role: 'toolResult',
                  toolCallId: 'ui',
                  toolName: 'present_openui',
                  content: [{ type: 'text', text: '{"panelRef":"2.ui","ready":true}' }],
                },
              ],
            },
          ]
        : []),
    ];
    let advance = () => {},
      appendThinking = () => {},
      appendAnswer = () => {},
      commit = () => {},
      restore = () => {},
      finish = () => {},
      committed = false,
      done = false,
      observations = 0;
    const server = createServer((_request, response) => {
      observations++;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': '*',
      });
      const emit = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      const projection = new DraftProjection(messageId, emit);
      emit({ type: 'RUN_STARTED', threadId: 'a', runId });
      emit({ type: 'MESSAGES_SNAPSHOT', messages: [] });
      expect(projection.publish(draft(false))).toBe(true);
      advance = () => expect(projection.publish(draft(true))).toBe(true);
      appendThinking = () => {
        thinking += '再校验边界。';
        expect(projection.publish(draft(true))).toBe(true);
      };
      appendAnswer = () => {
        content += '，以及后续追加';
        expect(projection.publish(draft(true))).toBe(true);
      };
      commit = () => {
        committed = true;
        expect(projection.publish(draft(true), true)).toBe(true);
        emit({ type: 'STATE_SNAPSHOT', snapshot: { runId, messageIds: { '2': messageId } } });
        const messages = toMessages(entries(), new Map([['2', messageId]]));
        for (const message of messages) if (message.role === 'tool') emit(toolResultEvent(message));
        emit({
          type: 'MESSAGES_SNAPSHOT',
          messages,
        });
      };
      finish = () => {
        done = true;
        emit({ type: 'RUN_FINISHED', threadId: 'a', runId });
        response.end();
      };
      restore = () => emit({ type: 'MESSAGES_SNAPSHOT', messages: toMessages(entries()) });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await page.route('**/api/conversations/**', (route) => {
        const url = route.request().url();
        if (url.endsWith('/capabilities'))
          return route.fulfill({ json: { extensionIds: ['web', 'openui', 'example'] } });
        if (url.endsWith('/events'))
          return route.continue({ url: `http://127.0.0.1:${port}/events` });
        if (url.includes('/extensions/openui/resources/'))
          return route.fulfill({
            json: resource({ panelRef: '2.ui', ui: ui(), program: null, revision: 0 }),
          });
        return route.fulfill({
          json: {
            entries: committed ? entries() : [],
            pending: done ? [] : [{ operationId: runId, status: 'running' }],
            stopping: false,
          },
        });
      });
      await page.goto('/tests/browser/chat.html');
      await expect(page.getByRole('button', { name: '正在思考…', exact: true })).toBeVisible();
      await expect(page.getByText(thinking, { exact: true })).toBeVisible();
      advance();
      await expect(page.getByText(content, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '正在思考…', exact: true })).toHaveCount(0);
      const reasoning = page.getByRole('button', { name: '思考过程', exact: true });
      await expect(reasoning).toHaveCount(1);
      await expect(reasoning).toHaveAttribute('aria-expanded', 'false');
      await reasoning.click();
      await expect(page.locator('[data-slot="reasoning-content"]')).toHaveAttribute(
        'aria-busy',
        'false',
      );
      const disclosureNode = await reasoning.elementHandle();
      appendThinking();
      await expect(page.getByText(thinking, { exact: true })).toBeVisible();
      appendAnswer();
      await expect(page.getByText(content, { exact: true })).toBeVisible();
      await expect(reasoning).toHaveAttribute('aria-expanded', 'true');
      expect(await disclosureNode!.evaluate((node) => node.isConnected)).toBe(true);
      expect(observations).toBe(1);
      commit();
      await expect(page.getByText(thinking, { exact: true })).toHaveCount(1);
      await expect(page.getByText(content, { exact: true })).toHaveCount(1);
      await expect(reasoning).toHaveAttribute('aria-expanded', 'true');
      expect(await disclosureNode!.evaluate((node) => node.isConnected)).toBe(true);
      restore();
      await expect(page.getByText(thinking, { exact: true })).toHaveCount(1);
      await expect(page.getByText(content, { exact: true })).toHaveCount(1);
      await expect(reasoning).toHaveAttribute('aria-expanded', 'true');
      expect(await disclosureNode!.evaluate((node) => node.isConnected)).toBe(true);
      finish();
      await expect(page.getByRole('button', { name: '停止并撤回排队', exact: true })).toHaveCount(
        0,
      );
      await expect(reasoning).toHaveAttribute('aria-expanded', 'true');
      expect(await disclosureNode!.evaluate((node) => node.isConnected)).toBe(true);
      expect(await disclosureNode!.evaluate((node) => node.isConnected)).toBe(true);
      expect(observations).toBe(1);
      await page.reload();
      await expect(page.getByText(content, { exact: true })).toHaveCount(1);
      await expect(reasoning).toHaveCount(1);
      await reasoning.click();
      await expect(page.getByText(thinking, { exact: true })).toHaveCount(1);
      expect(observations).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

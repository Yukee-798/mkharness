import { snapshotFixture } from './chat-fixtures';
import { resource } from './fixtures';
import { test, expect } from './fixtures';

for (const replaced of [false, true])
  test(`${replaced ? 'replacing the stream' : 'finishing an answer'} refreshes history without replacing the viewport, panel or composer`, async ({
    page,
  }) => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const ui = '$cost="10"\nroot=Stack([Input("cost","Cost","text",null,$cost)])';
    const entries: any[] = [
      {
        conversationId: 1,
        kind: 'pi.assistant',
        id: 1,
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: Array(80).fill('Existing history paragraph.').join('\n\n') },
            ],
          },
        ],
      },
      {
        conversationId: 1,
        kind: 'pi.assistant',
        id: 2,
        model: [
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call', name: 'present_openui', arguments: { ui } }],
          },
        ],
      },
      {
        conversationId: 1,
        kind: 'pi.tool-result',
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
    ];
    let snapshots = 0,
      observations = 0,
      finish = () => {},
      refresh = () => {},
      finishResumed = () => {};
    const completion = new Promise<void>((resolve) => (finish = resolve));
    const refreshed = new Promise<void>((resolve) => (refresh = resolve));
    const resumed = new Promise<void>((resolve) => (finishResumed = resolve));
    await page.route('**/api/conversations/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/capabilities'))
        return route.fulfill({ json: { extensionIds: ['web', 'openui', 'example'] } });
      if (path.endsWith('/state')) return route.fulfill({ json: { revision: 1 } });
      if (path.includes('/extensions/openui/resources/'))
        return route.fulfill({
          json: resource({ panelRef: '2.call', ui, program: null, revision: 0 }),
        });
      if (path.endsWith('/snapshot')) {
        snapshots++;
        if (snapshots > 1) await refreshed;
        return route.fulfill({
          json: snapshotFixture({
            entries,
            pending:
              snapshots === 1 || (replaced && snapshots === 2)
                ? [{ operationId: runId, status: 'running' }]
                : [],
            stopping: false,
          }),
        });
      }
      if (path.endsWith('/events')) {
        observations++;
        const reset = replaced && observations === 1;
        if (observations === 1) {
          await completion;
          entries.push({
            conversationId: 1,
            kind: 'pi.assistant',
            id: 4,
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Finished answer.' }] }],
          });
        } else await resumed;
        return route.fulfill({
          contentType: 'text/event-stream',
          body: [
            { type: 'RUN_STARTED', threadId: 'a', runId },
            ...(reset
              ? [
                  { type: 'TEXT_MESSAGE_START', messageId: 'old-draft', role: 'assistant' },
                  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'old-draft', delta: 'Old draft.' },
                  { type: 'TEXT_MESSAGE_END', messageId: 'old-draft' },
                  { type: 'CUSTOM', name: 'pi.reset', value: { runId } },
                ]
              : [{ type: 'RUN_FINISHED', threadId: 'a', runId }]),
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        });
      }
      return route.fulfill({ status: 404 });
    });
    try {
      await page.goto('/tests/browser/chat.html');
      const field = page.getByPlaceholder('Cost');
      await expect(field).toHaveValue('10');
      await field.fill('12.');
      const composer = page.getByLabel('消息', { exact: true });
      await composer.fill('Unsent next question');
      const viewport = page.locator('[data-slot="chat-viewport"]');
      await viewport.evaluate((element) => (element.scrollTop = 100));
      await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(100);
      const nodes = await Promise.all([
        viewport.elementHandle(),
        field.elementHandle(),
        composer.elementHandle(),
      ]);
      finish();
      await expect.poll(() => snapshots).toBe(2);
      // Keep the authoritative snapshot delayed: existing content must stay usable while it loads.
      for (const node of nodes)
        expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(page.getByText('正在恢复聊天…', { exact: true })).toHaveCount(0);
      refresh();
      await expect(page.getByText('Finished answer.', { exact: true })).toBeAttached();
      for (const node of nodes)
        expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(composer).toBeFocused();
      await expect(composer).toHaveValue('Unsent next question');
      await expect(field).toHaveValue('12.');
      await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(100);
      if (replaced) {
        await expect.poll(() => observations).toBe(2);
        await expect(page.getByText('Old draft.', { exact: true })).toHaveCount(0);
        finishResumed();
      }
      await expect(page.getByText('任务运行中', { exact: true })).toHaveCount(0);
      for (const node of nodes)
        expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
      await expect(page.getByText('Finished answer.', { exact: true })).toHaveCount(1);
    } finally {
      finish();
      refresh();
      finishResumed();
    }
  });

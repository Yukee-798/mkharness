import { test, expect } from './fixtures';
import { toMessages } from '../../src/shared/stream';

const entries = (first: number, last: number): any[] =>
  Array.from({ length: last - first + 1 }, (_, i) => ({
    id: first + i,
    model: [{ role: 'user', content: `History message ${first + i}`, timestamp: first + i }],
  }));
const history = (olderCursor?: string) => ({
  upperEntryId: 200,
  revision: 1,
  annotations: {},
  ...(olderCursor ? { olderCursor } : {}),
});
const answer = (id: number) => ({
  id,
  model: [{ role: 'assistant', content: [{ type: 'text', text: `History message ${id}` }] }],
});

for (const retry of [false, true])
  test(`loads older messages at the top and preserves focus and scroll anchor${retry ? ' after retry' : ''}`, async ({
    page,
  }) => {
    let reads = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/conversations/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/snapshot'))
        return route.fulfill({
          json: {
            entries: [...entries(101, 199), answer(200)],
            pending: [],
            stopping: false,
            history: {
              ...history('older'),
              annotations: {
                '200': { reply: { replies: { '200': ['Follow this latest answer'] } } },
              },
            },
          },
        });
      if (path.endsWith('/history')) {
        reads++;
        if (retry && reads === 1)
          return route.fulfill({ status: 503, json: { error: { code: 'temporary' } } });
        await gate;
        return route.fulfill({
          json: {
            entries: [...entries(1, 99), answer(100)],
            history: {
              ...history(),
              annotations: {
                '100': {
                  web: {
                    replies: {
                      '100': [{ title: 'Older source', url: 'https://example.com/older' }],
                    },
                  },
                  reply: { replies: { '100': ['Old suggestion'] } },
                },
              },
            },
          },
        });
      }
      return route.fulfill({ status: 404 });
    });
    try {
      await page.goto('/tests/browser/chat.html');
      await expect(page.getByText('History message 200', { exact: true })).toBeAttached();
      expect(reads).toBe(0);
      await expect(page.getByText('History message 1', { exact: true })).toHaveCount(0);
      const composer = page.getByLabel('消息', { exact: true });
      await composer.fill('Keep this unsent draft');
      const viewport = page.locator('[data-slot="chat-viewport"]');
      await viewport.evaluate((node) => {
        node.scrollTop = 0;
        node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      });
      await expect.poll(() => reads).toBe(1);
      if (retry) {
        await page.getByRole('button', { name: '历史消息加载失败，点击重试' }).click();
        await expect.poll(() => reads).toBe(2);
        await composer.focus();
      }
      const anchor = page.locator('[data-message-id="101"]');
      const before = await anchor.evaluate((node) => node.getBoundingClientRect().top);
      release();
      await expect(page.getByText('History message 1', { exact: true })).toBeAttached();
      await expect
        .poll(async () =>
          Math.abs((await anchor.evaluate((node) => node.getBoundingClientRect().top)) - before),
        )
        .toBeLessThan(2);
      await expect(composer).toHaveValue('Keep this unsent draft');
      await expect(composer).toBeFocused();
      await expect(page.locator('[data-message-id]')).toHaveCount(200);
      await expect(page.locator('[data-message-id="100"] [data-slot="sources"]')).toHaveCount(1);
      await expect(
        page.getByRole('button', { name: 'Follow this latest answer', exact: true }),
      ).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Old suggestion', exact: true })).toHaveCount(
        0,
      );
      expect(reads).toBe(retry ? 2 : 1);
    } finally {
      release();
    }
  });

test('paging while generating keeps one stream and retains older messages through tail snapshots', async ({
  page,
}) => {
  const { createServer } = await import('node:http');
  const runId = '11111111-1111-4111-8111-111111111111';
  let observations = 0;
  let done = false;
  let snapshots = 0;
  let emit: (event: any) => void = () => {};
  let finish = () => {};
  const tail = entries(101, 200);
  const server = createServer((_request, response) => {
    observations++;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Access-Control-Allow-Origin': '*',
    });
    emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    finish = () => response.end();
    emit({ type: 'RUN_STARTED', threadId: 'a', runId });
    emit({ type: 'MESSAGES_SNAPSHOT', messages: toMessages(tail) });
    emit({ type: 'TEXT_MESSAGE_START', messageId: 'live', role: 'assistant' });
    emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'live', delta: 'Still generating' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await page.route('**/api/conversations/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) return route.continue({ url: `http://127.0.0.1:${port}/events` });
    if (path.endsWith('/snapshot')) {
      snapshots++;
      return route.fulfill({
        json: {
          entries: done ? entries(301, 400) : tail,
          pending: done ? [] : [{ operationId: runId, status: 'running' }],
          stopping: false,
          history: { ...history('older'), upperEntryId: done ? 400 : 200 },
        },
      });
    }
    if (path.endsWith('/history'))
      return route.fulfill({ json: { entries: entries(1, 100), history: history() } });
    return route.fulfill({ status: 404 });
  });
  try {
    await page.goto('/tests/browser/chat.html');
    await expect(page.getByText('Still generating', { exact: true })).toBeAttached();
    const viewport = page.locator('[data-slot="chat-viewport"]');
    await viewport.evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    });
    await expect(page.getByText('History message 1', { exact: true })).toBeAttached();
    await expect(page.getByText('Still generating', { exact: true })).toBeAttached();
    expect(observations).toBe(1);
    emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'live', delta: ' after paging' });
    await expect(page.getByText('Still generating after paging', { exact: true })).toBeAttached();
    emit({ type: 'TEXT_MESSAGE_END', messageId: 'live' });
    emit({
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        ...toMessages(tail),
        { id: 'live', role: 'assistant', content: 'Still generating after paging' },
      ],
    });
    await expect(page.getByText('History message 1', { exact: true })).toBeAttached();
    await expect(page.getByText('Still generating after paging', { exact: true })).toHaveCount(1);
    expect(observations).toBe(1);
    emit({ type: 'STATE_SNAPSHOT', snapshot: { runId, messageIds: { '201': 'live' } } });
    emit({
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        ...toMessages(tail),
        { id: '201', role: 'assistant', content: 'Still generating after paging' },
        ...toMessages(entries(202, 400)),
      ],
    });
    await expect(page.getByText('History message 250', { exact: true })).toBeAttached();
    done = true;
    emit({ type: 'RUN_FINISHED', threadId: 'a', runId });
    finish();
    await expect.poll(() => snapshots).toBe(2);
    await expect(page.getByText('History message 400', { exact: true })).toBeAttached();
    await expect(page.getByText('History message 250', { exact: true })).toHaveCount(1);
    await expect(page.getByText('History message 1', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Still generating after paging', { exact: true })).toHaveCount(1);
    expect(observations).toBe(1);
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

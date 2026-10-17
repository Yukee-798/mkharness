import { snapshotFixture } from './chat-fixtures';
import { test, expect } from './fixtures';
test('disabled generated UI never evaluates its module, CSS, Worker or Inspect and base tools remain available', async ({
  page,
}) => {
  const loaded: string[] = [];
  page.on('request', (request) => loaded.push(request.url()));
  await page.addInitScript(() => {
    (window as any).workerCount = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (window as any).workerCount++;
      }
    };
  });
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ json: { extensionIds: ['web', 'example'] } }),
  );
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
                    id: 'one',
                    name: 'describe_text',
                    arguments: { text: 'abc' },
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
                toolCallId: 'one',
                toolName: 'describe_text',
                content: [{ type: 'text', text: '{"characters":3}' }],
                isError: false,
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
                content: [{ type: 'text', text: 'Base chat remains available.' }],
              },
            ],
          },
        ],
        pending: [],
        stopping: false,
      }),
    }),
  );
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByText('文字包含 3 个字符。')).toBeVisible();
  await expect(page.getByText('Base chat remains available.')).toBeVisible();
  expect(
    loaded.some((url) =>
      /extensions\/openui|openuidev|compute\.worker|quickjs|emscripten|devtools/.test(url),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => (window as any).workerCount)).toBe(0);
  const input = await page.getByLabel('消息', { exact: true }).elementHandle();
  await page.getByLabel('消息', { exact: true }).fill('Keep my draft');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Keep my draft');
  expect(await input!.evaluate((element) => element.isConnected)).toBe(true);
});

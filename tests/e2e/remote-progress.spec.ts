import { test, expect } from './fixtures';
test('unknown outcomes restore without submission; explicit actions send only the original task reference', async ({
  page,
}) => {
  const commands: any[] = [];
  await page.route('**/api/conversations/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/capabilities'))
      return route.fulfill({ json: { extensionIds: ['web', 'openui', 'example'] } });
    if (path.endsWith('/snapshot'))
      return route.fulfill({
        json: {
          entries: [],
          pending: [],
          stopping: false,
          remote: [
            {
              taskId: 12,
              runId: 'previous',
              status: 'unknown',
              remoteStatus: 'unknown',
              deadline: 123,
            },
          ],
        },
      });
    if (path.endsWith('/runs')) {
      commands.push(route.request().postDataJSON());
      await new Promise((r) => setTimeout(r, 200));
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByText('结果暂时无法确认', { exact: true })).toBeVisible();
  await page.reload();
  expect(commands).toHaveLength(0);
  await page.getByRole('button', { name: '重新执行（可能重复执行）' }).click();
  await expect(page.getByRole('button', { name: '复查原任务' })).toBeDisabled();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0].source).toEqual({ action: 'retry_remote', taskId: 12 });
  await expect(page.getByRole('button', { name: '复查原任务' })).toBeEnabled();
  await page.getByRole('button', { name: '复查原任务' }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1].source).toEqual({ action: 'recheck_remote', taskId: 12 });
  expect(commands[0].runId).not.toBe(commands[1].runId);
});

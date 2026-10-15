import { test, expect } from './fixtures';
test('unknown outcomes restore without submission; explicit actions send only the original task reference', async ({
  page,
}) => {
  const commands: any[] = [];
  let enabled = true;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/capabilities'))
      return route.fulfill({
        json: {
          extensionIds: enabled
            ? ['web', 'openui', 'example', 'async-example']
            : ['web', 'openui', 'example'],
        },
      });
    if (path.endsWith('/snapshot'))
      return route.fulfill({
        json: {
          entries: [],
          pending: [],
          stopping: false,
          extensionState: {
            'async-example': [
              {
                taskId: 12,
                runId: 'previous',
                status: 'unknown',
                remoteStatus: 'unknown',
                deadline: 123,
              },
            ],
          },
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
  expect(commands[0].source).toEqual({
    action: 'extension_action',
    extensionId: 'async-example',
    name: 'retry',
    payload: { taskId: 12 },
  });
  await expect(page.getByRole('button', { name: '复查原任务' })).toBeEnabled();
  await page.getByRole('button', { name: '复查原任务' }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1].source).toEqual({
    action: 'extension_action',
    extensionId: 'async-example',
    name: 'recheck',
    payload: { taskId: 12 },
  });
  expect(commands[0].runId).not.toBe(commands[1].runId);
  enabled = false;
  await page.reload();
  await expect(page.getByPlaceholder('描述你的问题，或说说你想完成什么')).toBeVisible();
  await expect(page.locator('[data-slot=remote-progress]')).toHaveCount(0);
  expect(commands).toHaveLength(2);
});

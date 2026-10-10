import { test, expect } from '@playwright/test';
const catalog = {
  models: [
    {
      id: 'flash',
      name: 'DeepSeek Flash',
      provider: 'deepseek',
      thinkingLevels: ['off', 'low', 'high', 'max'],
    },
    {
      id: 'pro',
      name: 'DeepSeek Pro',
      provider: 'deepseek',
      thinkingLevels: ['off', 'high', 'max'],
    },
    { id: 'plain', name: 'Plain text', provider: 'fixture', thinkingLevels: ['off'] },
  ],
  defaultSelection: { modelId: 'flash', thinkingLevel: 'low' },
};
test('model and effort apply to new HTTP submissions, preserve busy work and restore after reload', async ({
  page,
}) => {
  const commands: any[] = [];
  let selection = catalog.defaultSelection;
  await page.route('**/api/conversations/**', async (route) => {
    const req = route.request(),
      url = req.url();
    if (url.endsWith('/runs') && req.method() === 'POST') {
      const command = req.postDataJSON();
      commands.push(command);
      selection = command.config;
      return route.fulfill({ status: 202, json: { accepted: true, runId: command.runId } });
    }
    if (url.endsWith('/snapshot'))
      return route.fulfill({
        json: { entries: [], pending: [], stopping: false, modelCatalog: catalog, selection },
      });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/tests/browser/chat.html');
  const trigger = page.getByRole('combobox', { name: '模型与思考强度' });
  await expect(trigger).toContainText('DeepSeek Flash');
  await expect(trigger).toContainText('低');
  await trigger.click();
  await page.getByRole('radio', { name: '最高', exact: true }).click();
  await expect(page.getByRole('radio', { name: '最高', exact: true })).toHaveAttribute(
    'data-state',
    'checked',
  );
  await page.keyboard.press('Escape');
  await page.getByLabel('消息', { exact: true }).fill('first');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0].config).toEqual({ modelId: 'flash', thinkingLevel: 'max' });
  await trigger.click();
  await page.getByRole('option', { name: 'DeepSeek Pro' }).click();
  await trigger.click();
  await expect(page.getByRole('radio', { name: '低', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: '高', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByLabel('消息', { exact: true }).fill('second');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1].config).toEqual({ modelId: 'pro', thinkingLevel: 'high' });
  await page.reload();
  await expect(trigger).toContainText('DeepSeek Pro');
  await expect(trigger).toContainText('高');
  expect(commands).toHaveLength(2);
});
test('keyboard selection, model capability changes and a mobile popover stay usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({ json: { entries: [], pending: [], stopping: false, modelCatalog: catalog } }),
  );
  await page.goto('/tests/browser/chat.html');
  const trigger = page.getByRole('combobox', { name: '模型与思考强度' });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('DeepSeek Pro');
  await expect(trigger).toContainText('高');
  await trigger.click();
  const popup = page.locator('[data-slot="model-selector-content"]');
  const bounds = await popup.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  await page.getByRole('option', { name: 'Plain text' }).click();
  await trigger.click();
  await expect(page.getByRole('radiogroup', { name: '思考强度' })).toHaveCount(0);
  await page.getByRole('option', { name: 'DeepSeek Flash' }).click();
  await trigger.click();
  await expect(page.getByRole('radio', { name: '关闭', exact: true })).toHaveAttribute(
    'data-state',
    'checked',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

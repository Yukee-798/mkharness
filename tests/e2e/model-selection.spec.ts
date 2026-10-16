import { test, expect } from './fixtures';
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
  defaultSelection: { provider: 'deepseek', modelId: 'flash', thinkingLevel: 'low' },
};
test('model and effort apply on new HTTP submissions and restore selection without submitting on reload', async ({
  page,
}) => {
  const commands: any[] = [];
  let selection = catalog.defaultSelection;
  await page.route('**/api/conversations/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()).pathname;
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
  expect(commands[0].config).toEqual({
    provider: 'deepseek',
    modelId: 'flash',
    thinkingLevel: 'max',
  });
  await trigger.click();
  await page.getByRole('option', { name: 'DeepSeek Pro' }).click();
  await trigger.click();
  await expect(page.getByRole('radio', { name: '低', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: '高', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByLabel('消息', { exact: true }).fill('second');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1].config).toEqual({
    provider: 'deepseek',
    modelId: 'pro',
    thinkingLevel: 'high',
  });
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

test.describe('English reasoning layout', () => {
  test.use({ uiLocale: 'en' });
  for (const width of [320, 375, 1280]) {
    test(`five effort choices fit below the label at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      const modelCatalog = {
        models: [
          {
            id: 'free',
            name: 'Free Models Router',
            provider: 'openrouter',
            thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
          },
        ],
        defaultSelection: { provider: 'openrouter', modelId: 'free', thinkingLevel: 'high' },
      };
      await page.route('**/api/conversations/**', (route) =>
        route.fulfill({
          json: { entries: [], pending: [], stopping: false, modelCatalog },
        }),
      );
      await page.goto('/tests/browser/chat.html');
      await page.getByRole('combobox', { name: 'Model and reasoning effort' }).click();
      const effort = page.locator('[data-slot="model-selector-effort"]');
      const layout = await effort.evaluate((element) => {
        const label = element.querySelector('span')!.getBoundingClientRect();
        const group = element.querySelector('[role="radiogroup"]')!.getBoundingClientRect();
        return {
          belowLabel: group.top >= label.bottom,
          choices: [...element.querySelectorAll('[role="radio"]')].map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              top: rect.top,
              leftOverflow: group.left - rect.left,
              rightOverflow: rect.right - group.right,
              textOverflow: button.scrollWidth - button.clientWidth,
            };
          }),
        };
      });
      expect(layout.belowLabel).toBe(true);
      expect(layout.choices).toHaveLength(5);
      expect(new Set(layout.choices.map((choice) => choice.top)).size).toBe(1);
      // Flex distributes fractional pixels; clientWidth/scrollWidth are rounded integers.
      for (const choice of layout.choices) {
        expect(choice.leftOverflow).toBeLessThanOrEqual(1);
        expect(choice.rightOverflow).toBeLessThanOrEqual(1);
        expect(choice.textOverflow).toBeLessThanOrEqual(1);
      }
      await expect(page.getByRole('radio', { name: 'High', exact: true })).toHaveAttribute(
        'data-state',
        'checked',
      );
      await page.getByRole('radio', { name: 'Minimal', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Minimal', exact: true })).toHaveAttribute(
        'data-state',
        'checked',
      );
    });
  }
});

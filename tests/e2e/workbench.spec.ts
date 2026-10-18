import { snapshotFixture } from './chat-fixtures';
import { test, expect, resource } from './fixtures';

for (const width of [1440, 390]) {
  test(`workspace navigation and a single resource editor preserve context at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const ui =
      '$goal="A"\nroot=Stack([Text("text","Workbench report"),Input("goal","Goal","text",null,$goal),Button("Continue report",Action([@ToAssistant("Continue report")]))])';
    const saved = { state: {} as Record<string, unknown>, revision: 0 };
    const submissions: unknown[] = [];
    await page.route('**/api/auth/get-session', (route) =>
      route.fulfill({
        json: {
          session: { id: 'session', userId: 'owner', expiresAt: '2027-01-01T00:00:00Z' },
          user: { id: 'owner', name: 'Yukee', email: 'owner@example.test' },
        },
      }),
    );
    await page.route('**/api/conversations', (route) =>
      route.fulfill({
        json: {
          items: [
            { id: 'one', title: 'Report one', updated_at: 1 },
            { id: 'two', title: 'Report two', updated_at: 2 },
          ],
          next: null,
        },
      }),
    );
    await page.route('**/api/conversations/*/snapshot*', (route) =>
      route.fulfill({
        json: snapshotFixture({
          entries: [
            {
              conversationId: 1,
              kind: 'pi.assistant',
              id: 2,
              model: [
                {
                  role: 'assistant',
                  content: [
                    { type: 'toolCall', id: 'report', name: 'present_openui', arguments: { ui } },
                  ],
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
                  toolCallId: 'report',
                  toolName: 'present_openui',
                  content: [{ type: 'text', text: '{"panelRef":"2.report","ready":true}' }],
                  details: { ref: '2.report' },
                  isError: false,
                },
              ],
            },
          ],
          pending: [],
          stopping: false,
        }),
      }),
    );
    await page.route('**/api/conversations/*/extensions/openui/resources/**', (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        saved.state = body.state;
        saved.revision = body.expectedRevision + 1;
        return route.fulfill({ json: { revision: saved.revision } });
      }
      return route.fulfill({
        json: resource({ panelRef: '2.report', ui, program: null, ...saved }),
      });
    });
    await page.route('**/api/conversations/*/runs', (route) => {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ status: 202, json: { accepted: true } });
    });
    const navigate = async (name: string) => {
      if (width < 768)
        await page.getByRole('button', { name: '打开聊天目录', exact: true }).click();
      await page
        .getByRole('navigation', { name: '工作台导航' })
        .getByRole('button', { name, exact: true })
        .click();
    };
    await page.goto('/?chat=one');
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await expect(input).toBeEnabled();
    await input.fill('Unsent report notes');
    await expect(page.getByText('Workbench report', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /交互式回答/ }).click();
    await expect(page.getByText('Workbench report', { exact: true })).toHaveCount(1);
    if (width >= 768) {
      const panel = page.getByRole('region', { name: '工作面板', exact: true });
      const before = (await panel.boundingBox())!.width;
      const handle = page.getByRole('separator');
      await handle.focus();
      await page.keyboard.press('ArrowLeft');
      await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before);
      await page.getByRole('button', { name: '最大化面板', exact: true }).click();
      await expect(input).toBeHidden();
      await expect(panel).toBeVisible();
      await page.getByRole('button', { name: '恢复面板大小', exact: true }).click();
      await expect(input).toBeVisible();
    }
    await page.getByPlaceholder('Goal', { exact: true }).fill('B');
    await expect.poll(() => saved.state.$goal).toBe('B');
    await page.getByRole('button', { name: '收起工作面板', exact: true }).click();
    await navigate('定时任务');
    await expect(page.getByText('即将开放', { exact: true })).toBeVisible();
    await navigate('插件市场');
    await expect(page.getByText('即将开放', { exact: true })).toBeVisible();
    await navigate('Agent');
    await expect(input).toHaveValue('Unsent report notes');
    await page.getByRole('button', { name: '打开工作面板', exact: true }).click();
    await expect(page.getByPlaceholder('Goal', { exact: true })).toHaveValue('B');
    expect(submissions).toEqual([]);
    await page.reload();
    await expect(page.getByPlaceholder('Goal', { exact: true })).toHaveValue('B');
    expect(submissions).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const close = page.getByRole('button', { name: '收起工作面板', exact: true });
    await expect(close).toBeInViewport();
    if (width < 768) {
      await expect
        .poll(async () => Math.round((await page.getByRole('dialog').boundingBox())!.x))
        .toBe(0);
      await expect(page.getByRole('button', { name: '最大化面板', exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: `test-results/workbench-${width}.png` });
  });
}

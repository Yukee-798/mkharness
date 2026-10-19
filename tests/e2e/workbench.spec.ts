import { snapshotFixture } from './chat-fixtures';
import { test, expect, resource } from './fixtures';

for (const width of [1440, 390]) {
  test(`inline UI keeps prose, inputs and workspace navigation together at ${width}px`, async ({
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
                    { type: 'text', text: '先看普通正文说明。' },
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
            {
              conversationId: 1,
              kind: 'pi.assistant',
              id: 4,
              model: [
                { role: 'assistant', content: [{ type: 'text', text: '再用普通正文解释结果。' }] },
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
    await page.addInitScript(() =>
      localStorage.setItem(
        'mkharness.workbench.owner',
        JSON.stringify({
          width: 45,
          memories: [
            [
              'one',
              {
                hidden: false,
                active: {
                  type: 'openui/preview',
                  key: '2.report',
                  target: { key: '2.report', ref: '2.report' },
                  chatId: 'one',
                },
              },
            ],
          ],
        }),
      ),
    );
    await page.goto('/?chat=one');
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await expect(input).toBeEnabled();
    await input.fill('Unsent report notes');
    await expect(page.getByText('先看普通正文说明。', { exact: true })).toBeVisible();
    const widget = page.getByRole('region', { name: '交互式回答', exact: true });
    await expect(widget.getByText('Workbench report', { exact: true })).toBeVisible();
    await expect(page.getByText('再用普通正文解释结果。', { exact: true })).toBeVisible();
    await expect(widget).toHaveCSS('border-top-style', 'solid');
    await expect(widget).toHaveCSS('border-top-width', '1px');
    await expect(page.getByRole('region', { name: '工作面板', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看新内容', exact: true })).toHaveCount(0);
    const inOrder = await widget.evaluate((element) => {
      const text = element.closest('[data-slot="chat-messages"]')?.textContent ?? '';
      return (
        text.indexOf('先看普通正文说明。') < text.indexOf('Workbench report') &&
        text.indexOf('Workbench report') < text.indexOf('再用普通正文解释结果。')
      );
    });
    expect(inOrder).toBe(true);
    await page.getByPlaceholder('Goal', { exact: true }).fill('B');
    await expect.poll(() => saved.state.$goal).toBe('B');
    await navigate('定时任务');
    await expect(page.getByText('即将开放', { exact: true })).toBeVisible();
    await navigate('插件市场');
    await expect(page.getByText('即将开放', { exact: true })).toBeVisible();
    await navigate('Agent');
    await expect(input).toHaveValue('Unsent report notes');
    await expect(page.getByPlaceholder('Goal', { exact: true })).toHaveValue('B');
    expect(submissions).toEqual([]);
    await page.reload();
    await expect(page.getByPlaceholder('Goal', { exact: true })).toHaveValue('B');
    expect(submissions).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByRole('region', { name: '工作面板', exact: true })).toHaveCount(0);
    if (width === 1440) {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (let round = 0; round < 12; round++) {
        await page.getByRole('button', { name: 'Report two', exact: true }).click();
        await expect(page).toHaveURL(/chat=two/);
        await expect(widget).toBeVisible();
        await page.getByRole('button', { name: '新建聊天', exact: true }).click();
        await expect(page).not.toHaveURL(/chat=/);
        await expect(widget).toHaveCount(0);
        await page.getByRole('button', { name: 'Report one', exact: true }).click();
        await expect(page).toHaveURL(/chat=one/);
        await expect(widget).toBeVisible();
      }
      expect(errors).toEqual([]);
    }
    await page.screenshot({ path: `test-results/openui-inline-${width}.png` });
  });
}

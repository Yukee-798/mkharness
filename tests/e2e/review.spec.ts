import { resource } from './fixtures';
import { test, expect } from './fixtures';

for (const conflict of [false, true])
  test(`a chat runtime refresh retains ${conflict ? 'a conflicted' : 'an unsaved'} raw panel draft`, async ({
    page,
  }) => {
    const ui = '$cost="10"\nroot=Stack([Input("cost","Cost","text",null,$cost)])';
    const entries = [
      {
        id: 2,
        model: [
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call', name: 'present_openui', arguments: { ui } }],
          },
        ],
      },
      {
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
    const patches: any[] = [];
    let saved = { $cost: '10' },
      revision = 0,
      snapshots = 0;
    await page.route('**/api/conversations/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/capabilities'))
        return route.fulfill({ json: { extensionIds: ['web', 'openui', 'example'] } });
      if (path.endsWith('/state')) {
        const body = route.request().postDataJSON();
        patches.push(body);
        if (conflict)
          return route.fulfill({ status: 409, json: { error: { code: 'revision_conflict' } } });
        saved = body.state;
        return route.fulfill({ json: { revision: ++revision } });
      }
      if (path.includes('/extensions/openui/resources/'))
        return route.fulfill({
          json: resource({ panelRef: '2.call', ui, program: null, state: saved, revision }),
        });
      if (path.endsWith('/snapshot')) {
        snapshots++;
        return route.fulfill({ json: { entries, pending: [], stopping: false } });
      }
      if (path.endsWith('/runs')) return route.fulfill({ status: 202, json: { accepted: true } });
      return route.fulfill({ status: 404 });
    });
    await page.goto('/tests/browser/chat.html');
    const field = page.getByPlaceholder('Cost');
    await expect(field).toHaveValue('10');
    await field.fill('12.');
    if (conflict) await expect(page.getByText('另一页面已更新', { exact: false })).toBeVisible();
    await page.getByLabel('消息', { exact: true }).fill('continue');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => snapshots).toBeGreaterThan(1);
    await expect(field).toHaveValue('12.');
    if (conflict) {
      await expect(page.getByText('另一页面已更新', { exact: false })).toBeVisible();
      expect(patches).toHaveLength(1);
    } else await expect.poll(() => patches.some((p) => p.state.$cost === '12.')).toBe(true);
  });

test('delayed native slider edits each restart the automatic writeback budget', async ({
  page,
}) => {
  const ui =
    '$amount=[1]\n$target=""\nresult=Query("run_program",{n:$amount},{next:"",ready:false})\nroot=Stack([Slider("amount","continuous",0,100,1,[1],"Amount",null,$amount),Input("target","Target","text",null,$target),StateSync($target,result.next,result.ready,{result:result,inputs:{n:$amount}})])';
  await page.route('**/api/conversations/test/extensions/openui/resources/**', (route) =>
    route.fulfill({
      json:
        route.request().method() === 'PATCH'
          ? { revision: 1 }
          : resource({
              panelRef: '2.same',
              ui,
              program: {
                code: 'export function compute(i){return {next:String(i.n[0]),ready:true}}',
                data: null,
              },
              revision: 0,
            }),
    }),
  );
  await page.goto('/tests/browser/panel.html');
  const panel = page.getByRole('region', { name: 'Interactive answer' }).first(),
    target = panel.getByPlaceholder('Target'),
    input = panel.locator('.openui-slider-block__input');
  await expect(target).toHaveValue('1');
  for (const n of ['2', '3', '4', '5', '6']) {
    await input.fill(n);
    await expect(target).toHaveValue(n);
  }
  const slider = panel.getByRole('slider');
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(target).toHaveValue('7');
  const track = panel.locator('.openui-slider-track');
  const bounds = await track.boundingBox();
  expect(bounds).not.toBeNull();
  await track.click({ position: { x: bounds!.width * 0.4, y: bounds!.height / 2 } });
  await expect
    .poll(async () => await target.inputValue())
    .toBe(await slider.getAttribute('aria-valuenow'));
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('a historical invalid slider is contained without crashing the chat', async ({ page }) => {
  const ui = 'root=Stack([Slider("x","discrete",0,10,0,[0],"Budget")])';
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({
      json: route.request().url().includes('/extensions/openui/resources/')
        ? resource({ panelRef: '2.call', ui, program: null, revision: 0 })
        : {
            entries: [
              {
                id: 2,
                model: [
                  {
                    role: 'assistant',
                    content: [
                      { type: 'toolCall', id: 'call', name: 'present_openui', arguments: { ui } },
                    ],
                  },
                ],
              },
              {
                id: 3,
                model: [
                  {
                    role: 'toolResult',
                    toolCallId: 'call',
                    toolName: 'present_openui',
                    content: [{ type: 'text', text: '{"panelRef":"2.call"}' }],
                  },
                ],
              },
            ],
            pending: [],
            stopping: false,
          },
    }),
  );
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByRole('alert').filter({ hasText: 'Slider' })).toBeVisible();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
});

test('a native slider flush during runtime replacement preserves its committed binding', async ({
  page,
}) => {
  const ui =
    '$amount=[1]\nroot=Stack([Slider("amount","continuous",0,100,1,[1],"Amount",null,$amount)])';
  let state = { $amount: [1] },
    revision = 0;
  const entries = [
    {
      id: 2,
      model: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call', name: 'present_openui', arguments: { ui } }],
        },
      ],
    },
    {
      id: 3,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call',
          toolName: 'present_openui',
          content: [{ type: 'text', text: '{"panelRef":"2.call"}' }],
        },
      ],
    },
  ];
  await page.route('**/api/conversations/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/capabilities'))
      return route.fulfill({ json: { extensionIds: ['web', 'openui', 'example'] } });
    if (path.endsWith('/state')) {
      state = route.request().postDataJSON().state;
      return route.fulfill({ json: { revision: ++revision } });
    }
    if (path.includes('/extensions/openui/resources/'))
      return route.fulfill({
        json: resource({ panelRef: '2.call', ui, program: null, state, revision }),
      });
    if (path.endsWith('/snapshot'))
      return route.fulfill({ json: { entries, pending: [], stopping: false } });
    return route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.goto('/tests/browser/chat.html');
  const input = page.locator('.openui-slider-block__input');
  await expect(input).toHaveValue('1');
  await page.getByLabel('消息', { exact: true }).fill('continue');
  await input.fill('2');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(input).toHaveValue('2');
  await expect.poll(() => state.$amount[0]).toBe(2);
});

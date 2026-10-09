import { test, expect } from '@playwright/test';
test('native streamed panel restores raw edits, isolates panels and submits a click snapshot', async ({
  page,
}) => {
  const patches: any[] = [];
  const ui =
    '$cost = "10"\nresult = Query("run_program",{cost:$cost},{next:0,ready:false})\nroot = Stack([Input("cost","Cost","text",null,$cost),StateSync($cost,result.next,result.ready,{result:result,inputs:{cost:$cost}}),Button("Analyze",Action([@ToAssistant("Analyze inputs")]))])';
  await page.route('**/api/conversations/test/panels/**', async (route) => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON());
      return route.fulfill({ json: { revision: patches.length } });
    }
    await route.fulfill({
      json: {
        panelRef: route.request().url().includes('2.same') ? '2.same' : '8.same',
        ui,
        program: {
          code: 'export function compute(i){return {next:i.cost,ready:true}}',
          data: null,
        },
        state: { $cost: '1.' },
        revision: 0,
      },
    });
  });
  await page.goto('/tests/browser/panel.html');
  const fields = page.getByPlaceholder('Cost');
  await expect(fields).toHaveCount(2);
  await expect(fields.nth(0)).toHaveValue('1.');
  await fields.nth(0).fill('');
  await expect(fields.nth(1)).toHaveValue('1.');
  await expect.poll(() => patches.some((p) => p.state.$cost === '')).toBe(true);
  await fields.nth(0).fill('12.');
  await page.getByText('Analyze', { exact: true }).first().click();
  expect(await page.evaluate(() => (window as any).submissions[0].source.state.$cost)).toBe('12.');
  await expect(fields.nth(1)).toHaveValue('1.');
});

test('StateSync uses the current cached Query result after an A to B to A input change', async ({
  page,
}) => {
  const ui =
    '$choice = "A"\n$target = ""\nresult = Query("run_program",{choice:$choice},{next:"",ready:false})\ncache = Query("run_program",{choice:"A"},{next:"",ready:false})\nroot = Stack([Input("choice","Choice","text",null,$choice),Input("target","Target","text",null,$target),Text("text",cache.next),StateSync($target,result.next,result.ready,{result:result,inputs:{choice:$choice}})])';
  await page.route('**/api/conversations/test/panels/**', async (route) =>
    route.fulfill({
      json:
        route.request().method() === 'PATCH'
          ? { revision: 1 }
          : {
              panelRef: '2.same',
              ui,
              program: {
                code: 'export function compute(i){return {next:i.choice,ready:true}}',
                data: null,
              },
              revision: 0,
            },
    }),
  );
  await page.goto('/tests/browser/panel.html');
  const choice = page.getByPlaceholder('Choice').first(),
    target = page.getByPlaceholder('Target').first();
  await expect(target).toHaveValue('A');
  await choice.fill('B');
  await expect(target).toHaveValue('B');
  await choice.fill('A');
  await expect(target).toHaveValue('A');
  await target.fill('manual');
  await expect(target).toHaveValue('A');
});

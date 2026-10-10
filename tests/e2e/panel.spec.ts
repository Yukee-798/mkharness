import { test, expect } from '@playwright/test';

test('native links open safely during the click without submitting an agent request', async ({
  page,
}) => {
  const ui =
    'root=ListBlock([ListItem("Video A","Source example.com",null,"观看",Action([@OpenUrl("https://example.com/video/1")]))],"number")';
  await page.addInitScript(() => {
    (window as any).openedUrls = [];
    window.open = (url, target, features) => {
      (window as any).openedUrls.push({
        url,
        target,
        features,
        active: navigator.userActivation.isActive,
      });
      return null;
    };
  });
  await page.route('**/api/conversations/test/panels/**', (route) =>
    route.fulfill({ json: { panelRef: '2.same', ui, program: null, state: {}, revision: 0 } }),
  );
  await page.goto('/tests/browser/panel.html');
  await page.getByRole('region', { name: 'Interactive answer' }).first().getByText('观看').click();
  expect(await page.evaluate(() => (window as any).openedUrls)).toEqual([
    {
      url: 'https://example.com/video/1',
      target: '_blank',
      features: 'noopener,noreferrer',
      active: true,
    },
  ]);
  expect(await page.evaluate(() => (window as any).submissions)).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('native assistant actions retain click-time context and inputs', async ({ page }) => {
  const ui =
    '$choice="A"\nroot=Stack([Input("choice","Choice","text",null,$choice),Button("Explain",Action([@ToAssistant("Explain this choice","Selected item: B")]))])';
  await page.route('**/api/conversations/test/panels/**', (route) =>
    route.fulfill({ json: { panelRef: '2.same', ui, program: null, state: {}, revision: 0 } }),
  );
  await page.goto('/tests/browser/panel.html');
  const panel = page.getByRole('region', { name: 'Interactive answer' }).first();
  await panel.getByPlaceholder('Choice').fill('B');
  await panel.getByRole('button', { name: 'Explain' }).click();
  expect(await page.evaluate(() => (window as any).submissions[0])).toEqual({
    text: 'Explain this choice',
    source: {
      panelRef: '2.same',
      action: 'continue_analysis',
      state: { $choice: 'B' },
      params: { context: 'Selected item: B' },
    },
  });
});

test('checks dynamic, row and legacy links on click while preserving local Set and Reset', async ({
  page,
}) => {
  // Mock loading bypasses publication so the browser guard faces adversarial content too.
  const ui = [
    '$url="https://example.com/initial"',
    'rows=[{title:"Safe row",url:"https://example.com/row"},{title:"Unsafe row",url:"javascript:alert(1)"}]',
    'root=Stack([Input("url","URL","text",null,$url),Button("Dynamic",Action([@OpenUrl($url)])),Button("Legacy",{type:"open_url",url:$url}),Button("Object step",Action([{type:"open_url",url:$url}])),ListBlock(@Each(rows,"r",ListItem(r.title,null,null,"Open",Action([@OpenUrl(r.url)]))),"number"),Button("Preset",Action([@Set($url,"https://example.net/preset")])),Button("Reset",Action([@Reset($url)])),Button("Missing",{type:"open_url"}),Button("Unavailable",{type:"delete_record",params:{id:42}})])',
  ].join('\n');
  await page.addInitScript(() => {
    (window as any).openedUrls = [];
    window.open = (url) => {
      (window as any).openedUrls.push(url);
      return null;
    };
  });
  await page.route('**/api/conversations/test/panels/**', (route) =>
    route.fulfill({ json: { panelRef: '2.same', ui, program: null, state: {}, revision: 0 } }),
  );
  await page.goto('/tests/browser/panel.html');
  const panel = page.getByRole('region', { name: 'Interactive answer' }).first();
  await panel.getByPlaceholder('URL').fill('javascript:alert(1)');
  for (const name of ['Dynamic', 'Legacy', 'Object step', 'Missing']) {
    await panel.getByRole('button', { name, exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('完整 HTTP 或 HTTPS 地址');
  }
  await panel.getByRole('button', { name: /Unsafe row/ }).click();
  expect(await page.evaluate(() => (window as any).openedUrls)).toEqual([]);
  await panel.getByRole('button', { name: /Safe row/ }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await panel.getByPlaceholder('URL').fill('https://example.org/current');
  for (const name of ['Dynamic', 'Legacy', 'Object step'])
    await panel.getByRole('button', { name, exact: true }).click();
  expect(await page.evaluate(() => (window as any).openedUrls)).toEqual([
    'https://example.com/row',
    'https://example.org/current',
    'https://example.org/current',
    'https://example.org/current',
  ]);
  await panel.getByRole('button', { name: 'Preset', exact: true }).click();
  await expect(panel.getByPlaceholder('URL')).toHaveValue('https://example.net/preset');
  await panel.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(panel.getByPlaceholder('URL')).toHaveValue('https://example.com/initial');
  await panel.getByRole('button', { name: 'Unavailable', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('此操作暂不可用');
  expect(await page.evaluate(() => (window as any).openedUrls.length)).toBe(4);
  expect(await page.evaluate(() => (window as any).submissions)).toEqual([]);
});

test('native select portals share the application theme and preserve keyboard selection', async ({
  page,
}) => {
  const ui =
    '$duration = "short"\nroot = Select("duration",[SelectItem("short","短期"),SelectItem("long","长期")],"选择周期",null,$duration)';
  await page.route('**/api/conversations/test/panels/**', async (route) => {
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ json: { revision: 1 } });
    }
    return route.fulfill({
      json: { panelRef: '2.same', ui, program: null, state: {}, revision: 0 },
    });
  });
  await page.goto('/tests/browser/panel.html');
  const select = page
    .getByRole('region', { name: 'Interactive answer' })
    .first()
    .getByRole('combobox');
  await select.click();
  await expect(page.getByRole('listbox')).toHaveClass(/openui-theme-portal-/);
  await page.getByRole('option', { name: '短期', exact: true }).press('ArrowDown');
  await page.getByRole('option', { name: '长期', exact: true }).press('Enter');
  await expect(select).toHaveText('长期');
  await expect(select).toBeFocused();
});

test('native clarification form validates, saves choices and submits only on explicit confirmation', async ({
  page,
}) => {
  const saved = new Map<string, { state: Record<string, unknown>; revision: number }>();
  const ui = [
    '$format = ""',
    '$topics = {}',
    '$notes = ""',
    'root = Form("clarification",Buttons([Button("按我的选择继续",Action([@ToAssistant("根据我的答案继续")]))]),[FormControl("希望怎样展示？（必选）",RadioGroup("format",[RadioItem("方案对比","并列比较选项","comparison"),RadioItem("执行步骤","按顺序解释","steps")],null,{required:true},$format)),FormControl("关心哪些方面？（可多选）",CheckBoxGroup("topics",[CheckBoxItem("预算","说明成本","cost"),CheckBoxItem("时间","说明进度","timing")],null,$topics)),FormControl("其他要求（选填）",Input("notes","补充要求","text",null,$notes))])',
  ].join('\n');
  await page.route('**/api/conversations/test/panels/**', async (route) => {
    const ref = route.request().url().includes('2.same') ? '2.same' : '8.same';
    if (route.request().method() === 'PATCH') {
      const { state, expectedRevision } = route.request().postDataJSON();
      const revision = expectedRevision + 1;
      saved.set(ref, { state, revision });
      return route.fulfill({ json: { revision } });
    }
    return route.fulfill({
      json: { panelRef: ref, ui, program: null, revision: 0, ...saved.get(ref) },
    });
  });
  await page.goto('/tests/browser/panel.html');
  const panels = page.getByRole('region', { name: 'Interactive answer' });
  const form = panels.first();
  const comparison = form.getByRole('radio', { name: '方案对比' });
  await expect(comparison).not.toBeChecked();
  await form.getByRole('button', { name: '按我的选择继续' }).click();
  expect(await page.evaluate(() => (window as any).submissions)).toHaveLength(0);
  await comparison.check();
  await form.getByRole('checkbox', { name: '预算' }).check();
  await form.getByPlaceholder('补充要求').fill('保留未知项，不代替我选择');
  await expect.poll(() => saved.get('2.same')?.state.$notes).toBe('保留未知项，不代替我选择');
  expect(await page.evaluate(() => (window as any).submissions)).toHaveLength(0);
  await expect(panels.nth(1).getByRole('radio', { name: '方案对比' })).not.toBeChecked();
  await expect(panels.nth(1).getByRole('checkbox', { name: '预算' })).not.toBeChecked();

  await page.reload();
  await expect(comparison).toBeChecked();
  await expect(form.getByRole('checkbox', { name: '预算' })).toBeChecked();
  await expect(form.getByPlaceholder('补充要求')).toHaveValue('保留未知项，不代替我选择');
  await form.getByRole('button', { name: '按我的选择继续' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).submissions.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).submissions[0])).toMatchObject({
    text: '根据我的答案继续',
    source: {
      panelRef: '2.same',
      action: 'continue_analysis',
      state: {
        $format: 'comparison',
        $topics: { cost: true, timing: false },
        $notes: '保留未知项，不代替我选择',
      },
    },
  });
});

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

import { expect, test, resource } from './fixtures';

test('lost save receipt reconciles through GET and saves the newer edit once', async ({ page }) => {
  const ui = '$n="0"\nroot=Input("n","Value","text",null,$n)';
  let state = { $n: '0' },
    revision = 0,
    reads = 0;
  const writes: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/conversations/test/extensions/openui/resources/**', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.expectedRevision !== revision)
        return route.fulfill({ status: 409, json: { error: { code: 'revision_conflict' } } });
      state = body.state;
      revision++;
      if (writes.length === 1) {
        await gate;
        return route.abort('failed');
      }
      return route.fulfill({ json: { revision } });
    }
    reads++;
    return route.fulfill({
      json: resource({ panelRef: '2.same', ui, program: null, state, revision }),
    });
  });
  try {
    await page.goto('/tests/browser/panel.html');
    const input = page
      .getByRole('region', { name: 'Interactive answer' })
      .first()
      .getByPlaceholder('Value');
    await input.fill('1.');
    await expect.poll(() => writes.length).toBe(1);
    await input.fill('12');
    release();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes).toEqual([
      { state: { $n: '1.' }, expectedRevision: 0 },
      { state: { $n: '12' }, expectedRevision: 1 },
    ]);
    expect(reads).toBeGreaterThan(1);
    await expect(input).toHaveValue('12');
    await expect(page.getByRole('button', { name: '重试保存' })).toHaveCount(0);
    expect(state).toEqual({ $n: '12' });
  } finally {
    release();
  }
});

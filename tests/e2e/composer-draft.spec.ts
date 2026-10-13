import { expect, test } from './fixtures';

for (const edit of ['new draft', 'same text', 'unchanged', 'failed receipt']) {
  test(`slow submission preserves the correct draft: ${edit}`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const commands: unknown[] = [];
    await page.route('**/api/conversations/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/runs')) {
        commands.push(route.request().postDataJSON());
        await gate;
        return route.fulfill(
          edit === 'failed receipt'
            ? { status: 400, json: { error: { code: 'rejected', message: 'Rejected' } } }
            : { status: 202, json: { accepted: true } },
        );
      }
      if (path.endsWith('/snapshot'))
        return route.fulfill({ json: { entries: [], pending: [], stopping: false } });
      return route.fulfill({ status: 404 });
    });
    try {
      await page.goto('/tests/browser/chat.html');
      const input = page.getByLabel('消息', { exact: true });
      await expect(input).toBeEnabled();
      await input.fill('original submission');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => commands.length).toBe(1);
      await expect(input).toBeEnabled();
      if (edit === 'new draft') await input.fill('my next draft');
      if (edit === 'same text') {
        await input.fill('');
        await input.fill('original submission');
      }
      const acknowledged = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith('/runs'),
      );
      release();
      await acknowledged;
      // Wait for the actual acknowledgement path before checking preserved text.
      if (edit === 'failed receipt')
        await expect(page.getByRole('alert')).toContainText('Rejected');
      else if (edit !== 'unchanged')
        await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
      await expect(input).toHaveValue(
        edit === 'unchanged' ? '' : edit === 'new draft' ? 'my next draft' : 'original submission',
      );
      expect(commands).toEqual([expect.objectContaining({ text: 'original submission' })]);
    } finally {
      release();
    }
  });
}

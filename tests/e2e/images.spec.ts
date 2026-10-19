import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures';
import { snapshotFixture } from './chat-fixtures';

for (const width of [1440, 390]) {
  test(`generated image stays inline until clicked and downloads the original at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const bytes = await readFile('public/brand/mkharness-logo.png');
    const result = {
      ref: '2.picture',
      title: '测试图片',
      images: [{ file: 'image-1.png', mediaType: 'image/png', bytes: bytes.length }],
    };
    const errors: string[] = [];
    let submissions = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/capabilities', (route) =>
      route.fulfill({ json: { extensionIds: ['images'] } }),
    );
    await page.route('**/api/auth/get-session', (route) =>
      route.fulfill({
        json: {
          session: { id: 'session', userId: 'owner', expiresAt: '2027-01-01T00:00:00Z' },
          user: { id: 'owner', name: 'Owner', email: 'owner@example.test' },
        },
      }),
    );
    await page.route('**/api/conversations', (route) =>
      route.fulfill({
        json: { items: [{ id: 'picture', title: '图片生成测试', updated_at: 1 }], next: null },
      }),
    );
    await page.route('**/api/conversations/picture/snapshot*', (route) =>
      route.fulfill({
        json: snapshotFixture({
          entries: [
            {
              id: 2,
              conversationId: 1,
              kind: 'pi.assistant',
              model: [
                {
                  role: 'assistant',
                  content: [
                    { type: 'text', text: '这是生成的图片：' },
                    {
                      type: 'toolCall',
                      id: 'picture',
                      name: 'generate_image',
                      arguments: { prompt: 'Fixture image', title: result.title },
                    },
                  ],
                },
              ],
            },
            {
              id: 3,
              conversationId: 1,
              kind: 'pi.tool-result',
              model: [
                {
                  role: 'toolResult',
                  toolName: 'generate_image',
                  toolCallId: 'picture',
                  isError: false,
                  details: { ref: result.ref },
                  content: [{ type: 'text', text: JSON.stringify(result) }],
                },
              ],
            },
            {
              id: 4,
              conversationId: 1,
              kind: 'pi.assistant',
              model: [
                {
                  role: 'assistant',
                  content: [{ type: 'text', text: '可以点击查看大图，也可以下载原图。' }],
                },
              ],
            },
          ],
          pending: [],
          stopping: false,
        }),
      }),
    );
    // Browser-owned download requests also need the context-level fixture.
    await context.route(
      '**/api/conversations/picture/extensions/images/resources/*/files/*',
      (route) =>
        route.fulfill({
          body: bytes,
          contentType: 'image/png',
          headers: {
            'Content-Disposition': route.request().url().includes('download=1')
              ? "attachment; filename*=UTF-8''image-1.png"
              : 'inline',
          },
        }),
    );
    await page.route('**/api/conversations/picture/runs', (route) => {
      submissions++;
      return route.fulfill({ status: 202, json: { accepted: true } });
    });
    await page.goto('/?chat=picture');
    const card = page.locator('[data-slot="generated-images"]');
    await expect(card.getByRole('img', { name: result.title })).toBeVisible();
    await expect(page.locator('[data-slot="image-preview"]')).toHaveCount(0);
    await expect(page.getByText('这是生成的图片：', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: '查看大图：测试图片' }).click();
    const preview = page.locator('[data-slot="image-preview"]');
    await expect(preview.getByRole('img', { name: result.title })).toBeVisible();
    await expect
      .poll(() =>
        preview
          .getByRole('img')
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    await preview.getByRole('button', { name: '放大图片', exact: true }).click();
    await expect(preview.getByLabel('图片缩放比例')).toHaveText('125%');
    await preview.getByRole('button', { name: '适应窗口', exact: true }).click();
    await expect(preview.getByLabel('图片缩放比例')).toHaveText('100%');
    const received = page.waitForEvent('download');
    await preview.getByRole('button', { name: '下载原图', exact: true }).click();
    const download = await received;
    expect(download.suggestedFilename()).toBe('image-1.png');
    await download.saveAs(`test-results/image-original-${width}.png`);
    expect(await readFile(`test-results/image-original-${width}.png`)).toEqual(bytes);
    await page.screenshot({ path: `test-results/image-preview-${width}.png` });
    await preview.getByRole('button', { name: '关闭图片预览' }).click();
    await expect(preview).toHaveCount(0);
    await card.getByRole('button', { name: '查看大图：测试图片' }).click();
    await page.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    await page.reload();
    await expect(card.getByRole('img', { name: result.title })).toBeVisible();
    await expect(preview).toHaveCount(0);
    expect(submissions).toBe(0);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

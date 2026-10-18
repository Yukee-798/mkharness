import { snapshotFixture } from './chat-fixtures';
import { test, expect, type Page } from './fixtures';
const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlp0AAAAASUVORK5CYII=';
async function workspace(page: Page) {
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      json: {
        session: { id: 'session', userId: 'user', expiresAt: '2027-01-01T00:00:00Z' },
        user: { id: 'user', name: 'Yukee', email: 'user@example.test' },
      },
    }),
  );
  let created = false;
  await page.route('**/api/conversations', (route) => {
    if (route.request().method() === 'POST') {
      created = true;
      return route.fulfill({ status: 201, json: { id: 'images' } });
    }
    return route.fulfill({
      json: {
        items: created ? [{ id: 'images', title: 'Images', updated_at: 1791576000001 }] : [],
        next: null,
      },
    });
  });
}
async function upload(
  page: Page,
  name = 'pixel.png',
  mimeType = 'image/png',
  buffer = Buffer.from(data, 'base64'),
) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType, buffer });
}
function history(command: any) {
  return [
    {
      conversationId: 1,
      kind: 'app.input',
      id: 1,
      model: [
        {
          role: 'user',
          content: [
            ...(command.text ? [{ type: 'text', text: command.text }] : []),
            ...command.images.map((image: any) => ({
              type: 'image',
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
          timestamp: 1,
        },
      ],
    },
    {
      conversationId: 1,
      kind: 'pi.assistant',
      id: 2,
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'Image received' }] }],
    },
  ];
}
test('native image picker previews/removes attachments and rejects non-image or oversized files', async ({
  page,
}) => {
  await workspace(page);
  await page.goto('/');
  await upload(page);
  await expect(page.getByRole('img', { name: 'pixel.png' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '移除图片', exact: true }).click();
  await expect(page.getByRole('img', { name: 'pixel.png' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await upload(page, 'notes.pdf', 'application/pdf', Buffer.from('document'));
  await expect(page.getByRole('alert')).toContainText('仅支持 PNG、JPEG、WebP 或 GIF 图片');
  await upload(page, 'large.png', 'image/png', Buffer.alloc(512 * 1024 + 1));
  await expect(page.getByRole('alert')).toContainText('图片总大小不能超过 512 KiB');
});
test('an image-only first message travels in one frozen command and remains visible after history restoration', async ({
  page,
}) => {
  await workspace(page);
  let command: any;
  let accepted = false;
  let acknowledge!: () => void;
  const receipt = new Promise<void>((resolve) => (acknowledge = resolve));
  await page.route('**/api/conversations/*/runs', async (route) => {
    command = route.request().postDataJSON();
    await receipt;
    accepted = true;
    return route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.route('**/api/conversations/*/snapshot*', (route) =>
    route.fulfill({
      json: snapshotFixture({
        entries: accepted ? history(command) : [],
        pending: [],
        stopping: false,
      }),
    }),
  );
  try {
    await page.goto('/');
    await upload(page);
    await expect(page.getByRole('img', { name: 'pixel.png' })).toBeVisible();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page).toHaveURL(/chat=images/);
    await expect(page.getByRole('img', { name: 'pixel.png' })).toBeVisible();
    await expect(page.getByText('提交中…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '提交中…', exact: true })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(command.text).toBe('');
    expect(command.images).toEqual([{ name: 'pixel.png', mimeType: 'image/png', data }]);
    acknowledge();
    await expect(page.getByText('Image received', { exact: true })).toBeVisible();
    await expect(
      page.locator('form').getByRole('img', { name: 'pixel.png', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'image', exact: true })).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole('img', { name: 'image', exact: true })).toBeVisible();
  } finally {
    acknowledge();
  }
});
test('a failed image receipt retries exactly once with unchanged bytes and does not erase a newer draft', async ({
  page,
}) => {
  await workspace(page);
  const commands: any[] = [];
  await page.route('**/api/conversations/*/runs', (route) => {
    commands.push(route.request().postDataJSON());
    return commands.length === 1
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'ack_lost', message: 'Receipt lost' } },
        })
      : route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.route('**/api/conversations/*/snapshot*', (route) =>
    route.fulfill({
      json: snapshotFixture({
        entries: commands.length > 1 ? history(commands[0]) : [],
        pending: [],
        stopping: false,
      }),
    }),
  );
  await page.goto('/');
  await upload(page);
  await page.getByLabel('消息', { exact: true }).fill('Describe this image');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Receipt lost');
  await page.getByLabel('消息', { exact: true }).fill('Keep my new draft');
  await upload(page, 'new.png');
  await page.getByRole('button', { name: '重试提交', exact: true }).click();
  await expect(page.getByText('Image received', { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(page.getByLabel('消息', { exact: true })).toHaveValue('Keep my new draft');
  await expect(page.getByRole('img', { name: 'new.png', exact: true })).toBeVisible();
});

test('chat switching restores image drafts and a late receipt removes only the submitted images', async ({
  page,
}) => {
  await workspace(page);
  await page.route('**/api/conversations', (route) =>
    route.fulfill({
      json: {
        items: [
          { id: 'one', title: 'One', updated_at: 1 },
          { id: 'two', title: 'Two', updated_at: 2 },
        ],
        next: null,
      },
    }),
  );
  await page.route('**/api/conversations/*/snapshot*', (route) =>
    route.fulfill({ json: snapshotFixture({ entries: [], pending: [], stopping: false }) }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitted = false;
  await page.route('**/api/conversations/*/runs', async (route) => {
    submitted = true;
    await gate;
    await route.fulfill({ status: 202, json: { accepted: true } });
  });
  try {
    await page.goto('/?chat=one');
    const input = page.getByLabel('消息', { exact: true });
    await expect(input).toBeEnabled();
    await input.fill('First draft');
    await upload(page, 'sent.png');
    await expect(page.getByRole('img', { name: 'sent.png' })).toBeVisible();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => submitted).toBe(true);
    await page.getByRole('button', { name: 'Two', exact: true }).click();
    await expect(input).toHaveValue('');
    await input.fill('Second chat draft');
    await page.getByRole('button', { name: 'One', exact: true }).click();
    await expect(input).toHaveValue('First draft');
    await expect(page.getByRole('img', { name: 'sent.png' })).toBeVisible();
    await input.fill('New first chat draft');
    release();
    await expect(page.getByRole('img', { name: 'sent.png' })).toHaveCount(0);
    await expect(input).toHaveValue('New first chat draft');
    await upload(page, 'new.png');
    await expect(page.getByRole('img', { name: 'new.png' })).toBeVisible();
    await page.getByRole('button', { name: 'Two', exact: true }).click();
    await expect(input).toHaveValue('Second chat draft');
    await page.getByRole('button', { name: 'One', exact: true }).click();
    await expect(page.getByRole('img', { name: 'sent.png' })).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'new.png' })).toBeVisible();
  } finally {
    release();
  }
});

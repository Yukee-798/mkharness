import { test, expect } from './fixtures';
test.use({ uiLocale: 'en' });
const sources = [
  {
    url: 'https://react.dev/learn',
    title: 'Learn React',
    snippet: 'Build declarative interfaces.',
  },
  {
    url: 'https://www.assistant-ui.com/docs',
    title: 'Assistant UI',
    snippet: 'Native chat primitives.',
  },
];
const history = [
  { id: 1, model: [{ role: 'user', content: 'Explain the architecture' }] },
  { id: 2, model: [{ role: 'assistant', content: [{ type: 'text', text: 'Original answer' }] }] },
];
const suggestions = {
  '2': ['Compare the architecture tradeoffs', 'Show how the extension boundary works'],
  '4': ['Trace one extension request through the host'],
};
test('native Sources persist on refetch, suggestions submit over HTTP and preserve drafts', async ({
  page,
}) => {
  const commands: any[] = [];
  const reads: string[] = [];
  let answered = false;
  await page.route('**/api/conversations/**', (route) => {
    const request = route.request();
    if (request.url().endsWith('/runs')) {
      commands.push(request.postDataJSON());
      answered = true;
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    if (request.url().endsWith('/snapshot'))
      return route.fulfill({
        json: {
          entries: answered
            ? [
                ...history,
                { id: 3, model: [{ role: 'user', content: commands.at(-1).text }] },
                {
                  id: 4,
                  model: [{ role: 'assistant', content: [{ type: 'text', text: 'Next answer' }] }],
                },
              ]
            : history,
          pending: [],
          stopping: false,
          extensionState: { web: { replies: { '2': sources } }, reply: { replies: suggestions } },
        },
      });
    reads.push(new URL(request.url()).pathname);
    return route.fulfill({ status: 404 });
  });
  await page.goto('/tests/browser/chat.html');
  await page.getByRole('button', { name: /Sources 2/ }).click();
  await expect(page.getByRole('link', { name: /Learn React/ })).toHaveAttribute(
    'href',
    'https://react.dev/learn',
  );
  const card = await page.getByRole('link', { name: /Learn React/ }).elementHandle();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('link', { name: /Learn React/ })).toBeVisible();
  expect(await card!.evaluate((el) => el.isConnected)).toBe(true);
  expect(commands).toHaveLength(0);
  await expect(
    page.getByRole('button', { name: 'Show me a concrete example', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Show how the extension boundary works', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Show how the extension boundary works', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Keep my unsent draft');
  await page
    .getByRole('button', { name: 'Show how the extension boundary works', exact: true })
    .click();
  await expect(page.getByText('Next answer', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Keep my unsent draft');
  expect(commands).toHaveLength(1);
  expect(commands[0].text).toBe('Show how the extension boundary works');
  expect(reads.some((path) => path.endsWith('/events'))).toBe(false);
  await expect(page.locator('[data-slot="suggestions"]')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Trace one extension request through the host', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show how the extension boundary works', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('Original answer', { exact: true })).toBeVisible();
});
test('regeneration preempts native reload, deduplicates double clicks and retries the frozen command', async ({
  page,
}) => {
  const commands: any[] = [];
  let completed = false,
    hold!: () => void;
  const held = new Promise<void>((resolve) => (hold = resolve));
  await page.route('**/api/conversations/**', async (route) => {
    if (route.request().url().endsWith('/runs')) {
      commands.push(route.request().postDataJSON());
      if (commands.length === 1) {
        await held;
        return route.fulfill({
          status: 503,
          json: { error: { code: 'ack_lost', message: 'Receipt unavailable' } },
        });
      }
      completed = true;
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    if (route.request().url().endsWith('/snapshot'))
      return route.fulfill({
        json: {
          entries: completed
            ? [
                ...history,
                { id: 3, model: [{ role: 'user', content: 'Regenerate response' }] },
                {
                  id: 4,
                  model: [{ role: 'assistant', content: [{ type: 'text', text: 'Fresh answer' }] }],
                },
              ]
            : history,
          pending: [],
          stopping: false,
        },
      });
    throw new Error('Unexpected native run/attach: ' + route.request().url());
  });
  try {
    await page.goto('/tests/browser/chat.html');
    const regenerate = page.getByRole('button', { name: 'Regenerate response', exact: true });
    await regenerate.dblclick();
    await expect(regenerate).toBeDisabled();
    await expect(page.locator('[data-slot="suggestions"]')).toHaveCount(0);
    expect(commands).toHaveLength(1);
    expect(commands[0].source).toEqual({
      action: 'extension_action',
      extensionId: 'reply',
      name: 'regenerate',
      payload: { entryId: '2' },
    });
    hold();
    await expect(page.getByRole('alert')).toContainText('Receipt unavailable');
    await page.getByRole('button', { name: 'Retry submission', exact: true }).click();
    await expect(page.getByText('Fresh answer', { exact: true })).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    await expect(page.getByText('Original answer', { exact: true })).toBeVisible();
  } finally {
    hold();
  }
});
test('removing optional reply and web display leaves native copy and chat intact', async ({
  page,
}) => {
  await page.route('**/api/capabilities', (route) => route.fulfill({ json: { extensionIds: [] } }));
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({
      json: {
        entries: history,
        pending: [],
        stopping: false,
        extensionState: { web: { replies: { '2': sources } }, reply: { replies: suggestions } },
      },
    }),
  );
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Regenerate response', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('[data-slot="sources"], [data-slot="suggestions"]')).toHaveCount(0);
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
});

test('missing suggestions stay absent and Chinese model prompts keep their language', async ({
  page,
}) => {
  let include = false;
  await page.route('**/api/conversations/**', (route) =>
    route.fulfill({
      json: {
        entries: history,
        pending: [],
        stopping: false,
        ...(include
          ? { extensionState: { reply: { replies: { '2': ['解释扩展隔离的作用'] } } } }
          : {}),
      },
    }),
  );
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="suggestions"]')).toHaveCount(0);
  include = true;
  await page.reload();
  await expect(page.getByRole('button', { name: '解释扩展隔离的作用', exact: true })).toBeVisible();
});

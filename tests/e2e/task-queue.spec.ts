import { snapshotFixture } from './chat-fixtures';
import { test, expect } from './fixtures';
test.use({ uiLocale: 'en' });
const image = {
  name: 'queued.png',
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlp0AAAAASUVORK5CYII=',
};
const inputs = [
  {
    runId: '11111111-1111-4111-8111-111111111111',
    text: 'Review the cache',
    mode: 'followUp',
    images: [image],
  },
  {
    runId: '22222222-2222-4222-8222-222222222222',
    text: 'Compare the tradeoffs',
    mode: 'followUp',
  },
  { runId: '33333333-3333-4333-8333-333333333333', text: 'Write the regression', mode: 'followUp' },
];
const draft = {
  text: inputs[0].text,
  images: [image],
  config: { provider: 'fixture', modelId: 'fixture-pro', thinkingLevel: 'high' },
  source: {
    action: 'extension_action',
    extensionId: 'reply',
    name: 'regenerate',
    payload: { entryId: '5' },
  },
};
async function fixture(
  page: any,
  options: { conflict?: boolean; loseEditAck?: boolean; lateAck?: boolean } = {},
) {
  let queue: any[] = structuredClone(inputs);
  const actions: any[] = [],
    commands: any[] = [];
  const transfers = new Map<string, { runId: string; expiresAt: number }>();
  const acknowledgements: { runId: string; text: string; images: number }[] = [];
  let hold!: () => void;
  const held = new Promise<void>((resolve) => (hold = resolve));
  let acknowledge!: () => void;
  const ack = new Promise<void>((resolve) => (acknowledge = resolve));
  let deliver!: () => void;
  const eventGate = new Promise<void>((resolve) => (deliver = resolve));
  let events = 0;
  await page.route('**/api/conversations/**', async (route: any) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/queue/ack')) {
      const runId = path.split('/').at(-3)!;
      acknowledgements.push({
        runId,
        text: await page.getByLabel('Message', { exact: true }).inputValue(),
        images: await page.getByRole('button', { name: 'Remove image' }).count(),
      });
      transfers.delete(runId);
      return route.fulfill({ status: 200, json: { acknowledged: true } });
    }
    if (path.endsWith('/queue')) {
      const { action } = req.postDataJSON();
      const id = path.split('/').at(-2)!;
      actions.push({ id, action });
      if (options.conflict) {
        queue = queue.filter((item) => item.runId !== id);
        return route.fulfill({ status: 409, json: { error: { code: 'queue_item_started' } } });
      }
      if (action === 'steer')
        queue = queue.map((item) => (item.runId === id ? { ...item, mode: 'steer' } : item));
      else queue = queue.filter((item) => item.runId !== id);
      if (action === 'edit') transfers.set(id, { runId: id, expiresAt: Date.now() + 86_400_000 });
      if (options.loseEditAck && actions.length === 1) {
        return route.fulfill({ status: 503, json: { error: { message: 'Receipt lost' } } });
      }
      const frozenQueue = structuredClone(queue);
      if (options.lateAck) await ack;
      return route.fulfill({
        json: {
          queue: frozenQueue,
          ...(action === 'edit' ? { draft } : {}),
        },
      });
    }
    if (path.endsWith('/snapshot'))
      return route.fulfill({
        json: snapshotFixture({
          entries: [
            {
              conversationId: 1,
              kind: 'app.input',
              id: 1,
              model: [{ role: 'user', content: 'Current work' }],
            },
          ],
          queue,
          queueEdits: [...transfers.values()],
          modelCatalog: {
            models: [
              {
                id: 'fixture',
                name: 'Fixture',
                provider: 'fixture',
                thinkingLevels: ['off', 'low', 'high'],
              },
              {
                id: 'fixture-pro',
                name: 'Fixture Pro',
                provider: 'fixture',
                thinkingLevels: ['off', 'low', 'high'],
              },
            ],
            defaultSelection: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'low' },
          },
          pending: [
            { operationId: 'active', status: 'running' },
            ...queue.map((item) => ({ operationId: item.runId, status: 'queued' as const })),
          ],
          stopping: false,
        }),
      });
    if (path.endsWith('/events')) {
      if (options.lateAck && events++ === 0) {
        await eventGate;
        const frames = [
          { type: 'RUN_STARTED', threadId: 'a', runId: 'active' },
          { type: 'STATE_SNAPSHOT', snapshot: { runId: 'active', queue: [] } },
          { type: 'RUN_FINISHED', threadId: 'a', runId: 'active' },
        ];
        return route.fulfill({
          contentType: 'text/event-stream',
          body: frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        });
      }
      await held;
      return route.abort();
    }
    if (path.endsWith('/runs')) {
      commands.push(req.postDataJSON());
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('/tests/browser/chat.html');
  await expect(page.getByRole('region', { name: 'Queued tasks' })).toBeVisible();
  return {
    actions,
    commands,
    acknowledgements,
    release: () => {
      hold();
      acknowledge();
      deliver();
    },
    acknowledge,
    finish: () => {
      queue = [];
      deliver();
    },
  };
}

test('compact native queue restores after refresh, collapses long lists and exposes steer/remove', async ({
  page,
}) => {
  const probe = await fixture(page);
  try {
    await expect(page.getByText('Queued · 3')).toBeVisible();
    await expect(page.locator('[data-slot=queue-item]')).toHaveCount(2);
    await expect(page.getByText('Write the regression')).toHaveCount(0);
    await expect(page.getByText('Task accepted. Queued tasks run in order.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(page.locator('[data-slot=queue-item]')).toHaveCount(3);
    await page.reload();
    await expect(page.getByText('Queued · 3')).toBeVisible();
    await expect(page.getByRole('img', { name: image.name })).toBeVisible();
    const row = page.locator('[data-slot=queue-item]').first();
    await row.getByRole('button', { name: 'Steer' }).dblclick();
    await expect(row.getByText('Steering pending')).toBeVisible();
    expect(probe.actions).toEqual([{ id: inputs[0].runId, action: 'steer' }]);
    await row.getByRole('button', { name: 'Remove queued message' }).click();
    await expect(page.getByText('Queued · 2')).toBeVisible();
    expect(probe.commands).toHaveLength(0);
    await page.reload();
    await expect(page.getByText('Review the cache')).toHaveCount(0);
  } finally {
    probe.release();
  }
});

test('edit restores text and native image attachments, keeps current drafts and submits a new operation', async ({
  page,
}) => {
  const probe = await fixture(page);
  try {
    const composer = page.getByLabel('Message', { exact: true });
    await composer.fill('Keep my draft');
    await expect(page.getByRole('button', { name: 'Edit', exact: true }).first()).toBeDisabled();
    await composer.fill('');
    await page.getByRole('button', { name: 'Edit', exact: true }).first().dblclick();
    await expect(composer).toHaveValue(inputs[0].text);
    await expect(page.getByRole('button', { name: 'Remove image' })).toBeVisible();
    expect(probe.actions).toHaveLength(1);
    await composer.fill('Revised cache request');
    await composer.press('Enter');
    await expect.poll(() => probe.commands.length).toBe(1);
    expect(probe.commands[0]).toMatchObject({ text: 'Revised cache request', images: [image] });
    expect(probe.commands[0].runId).not.toBe(inputs[0].runId);
  } finally {
    probe.release();
  }
});

test('placement conflict refreshes membership without filling or destroying the composer draft', async ({
  page,
}) => {
  const probe = await fixture(page, { conflict: true });
  try {
    await page.getByLabel('Message', { exact: true }).fill('Unsent draft');
    await page.getByRole('button', { name: 'Remove queued message' }).first().click();
    await expect(page.getByRole('alert')).toContainText('already started or ended');
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Unsent draft');
    await expect(page.getByText('Queued · 2')).toBeVisible();
    expect(probe.commands).toHaveLength(0);
  } finally {
    probe.release();
  }
});

test('lost edit receipt can retry the same withdrawn identity even after its queue row disappears', async ({
  page,
}) => {
  const probe = await fixture(page, { loseEditAck: true });
  try {
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await expect(page.getByRole('alert')).toContainText('Receipt lost');
    await expect(page.getByText('Review the cache')).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue(inputs[0].text);
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    expect(probe.actions).toEqual([
      { id: inputs[0].runId, action: 'edit' },
      { id: inputs[0].runId, action: 'edit' },
    ]);
    expect(probe.commands).toHaveLength(0);
  } finally {
    probe.release();
  }
});

test('a lost edit response remains discoverable after reload and restores the whole draft before acknowledgement', async ({
  page,
}) => {
  const probe = await fixture(page, { loseEditAck: true });
  try {
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await expect(page.getByRole('alert')).toContainText('Receipt lost');
    await page.reload();
    const recover = page.getByRole('button', { name: 'Restore draft', exact: true });
    await expect(recover).toBeVisible();
    const composer = page.getByLabel('Message', { exact: true });
    await composer.fill('Keep my current draft');
    await expect(recover).toBeDisabled();
    await expect(composer).toHaveValue('Keep my current draft');
    await composer.fill('');
    await recover.dblclick();
    await expect(composer).toHaveValue(draft.text);
    await expect(page.getByRole('button', { name: 'Remove image' })).toHaveCount(1);
    await expect
      .poll(() => probe.acknowledgements)
      .toEqual([{ runId: inputs[0].runId, text: draft.text, images: 1 }]);
    await expect(recover).toHaveCount(0);
    await composer.fill('Recovered and revised');
    await composer.press('Enter');
    await expect.poll(() => probe.commands.length).toBe(1);
    expect(probe.commands[0]).toMatchObject({ ...draft, text: 'Recovered and revised' });
    expect(probe.actions).toEqual([
      { id: inputs[0].runId, action: 'edit' },
      { id: inputs[0].runId, action: 'edit' },
    ]);
    await page.reload();
    await expect(page.getByText('Queued · 2')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore draft', exact: true })).toHaveCount(0);
  } finally {
    probe.release();
  }
});

test('a late HTTP queue receipt cannot restore tasks already consumed in the live SSE', async ({
  page,
}) => {
  const probe = await fixture(page, { lateAck: true });
  try {
    await page.getByRole('button', { name: 'Remove queued message' }).first().click();
    await expect.poll(() => probe.actions.length).toBe(1);
    probe.finish();
    await expect(page.locator('[data-slot=task-queue]')).toHaveCount(0);
    const receipt = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/queue'),
    );
    probe.acknowledge();
    await (await receipt).finished();
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    await expect(page.locator('[data-slot=task-queue]')).toHaveCount(0);
    expect(probe.commands).toHaveLength(0);
  } finally {
    probe.release();
  }
});

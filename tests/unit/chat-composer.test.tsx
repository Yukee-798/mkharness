// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Chat } from '../../src/browser/chat/Chat';
import {
  ComposerDraftsProvider,
  useComposerDraft,
  type ComposerDraft,
} from '../../src/browser/workbench/composer-drafts';
import { WorkspaceProvider, useWorkspace } from '../../src/browser/workspace/provider';
import { Button } from '../../src/browser/ui/button';
import { snapshotFixture } from '../e2e/chat-fixtures';

let draft: ComposerDraft;
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'EventSource',
    class {
      close() {}
      addEventListener() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function References({ id }: { id: string }) {
  draft = useComposerDraft(id);
  const w = useWorkspace()!;
  return <Button onClick={() => w.select([{ objectId: 'B', contentVersion: 1 }])}>Select B</Button>;
}
function mount(
  handler: (path: string, init?: RequestInit) => Promise<Response> | undefined,
  id = 'main',
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const handled = handler(path, init);
    if (handled) return handled;
    if (path === '/api/capabilities') return Response.json({ extensionIds: [] });
    if (path === '/api/settings/models')
      return Response.json({
        modelCatalog: {
          models: [
            { id: 'fixture', name: 'Fixture', provider: 'fixture', thinkingLevels: ['off'] },
          ],
          defaultSelection: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off' },
        },
        credentials: [{ provider: 'fixture', effectiveSource: 'server' }],
      });
    if (path.includes('/scenarios/chat/'))
      return Response.json({
        id: 'scene',
        mainChatId: 'main',
        kind: 'agent',
        workspaceId: 'workspace',
        title: 'Main',
        updatedAt: 1,
      });
    if (path.endsWith('/workspace/read'))
      return Response.json({
        objects: [{ id: 'B', type: 'note', title: 'Direction B', contentVersion: 1 }],
        assets: [],
        operations: [],
        watermark: 0,
      });
    if (path.includes('/snapshot'))
      return Response.json(snapshotFixture({ entries: [], pending: [], stopping: false }));
    throw new Error(`Unexpected request ${path}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ComposerDraftsProvider userId="owner">
        <WorkspaceProvider userId="owner" chatId="main">
          <References id={id} />
          <Chat id={id} userId="owner" />
        </WorkspaceProvider>
      </ComposerDraftsProvider>
    </QueryClientProvider>,
  );
}
it('restores queued references and chips before acknowledging transfer, and guards an existing selection', async () => {
  const refs = [
    { objectId: 'B', contentVersion: 1, anchor: 'summary', text: 'Selected paragraph' },
  ];
  const acknowledged = vi.fn();
  const page = mount((path) => {
    if (path.includes('/snapshot'))
      return Promise.resolve(
        Response.json(
          snapshotFixture({
            entries: [],
            pending: [],
            stopping: false,
            queue: [{ runId: 'queued', text: 'Revise this section', mode: 'followUp' }],
          }),
        ),
      );
    if (path.includes('/queue/ack')) {
      acknowledged(draft.getSnapshot().workspaceReferences, document.body.textContent);
      return Promise.resolve(Response.json({ ok: true }));
    }
    if (path.includes('/queue'))
      return Promise.resolve(
        Response.json({
          queue: [],
          draft: { text: 'Revise this section', workspaceReferences: refs },
        }),
      );
  });
  const edit = await page.findByRole('button', { name: 'Edit' });
  fireEvent.click(page.getByText('Select B'));
  await waitFor(() => expect(edit.hasAttribute('disabled')).toBe(true));
  await act(async () => draft.setWorkspaceReferences([]));
  fireEvent.click(edit);
  await waitFor(() => expect(acknowledged).toHaveBeenCalledOnce());
  expect(acknowledged.mock.calls[0][0]).toEqual(refs);
  expect(acknowledged.mock.calls[0][1]).toContain('Selected paragraph');
  expect((page.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Revise this section');
});
it.each(['button', 'enter'] as const)(
  'submits once through HTTP using native composer %s and preserves a newer selection',
  async (method) => {
    let acknowledge!: () => void;
    const commands: unknown[] = [];
    const page = mount((path, init) => {
      if (path.endsWith('/runs')) {
        commands.push(JSON.parse(init!.body as string));
        return new Promise((resolve) => {
          acknowledge = () => resolve(Response.json({ accepted: true }));
        });
      }
    });
    const input = page.getByLabelText('Message');
    await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
    await act(async () => draft.setWorkspaceReferences([{ objectId: 'A', contentVersion: 1 }]));
    fireEvent.change(input, { target: { value: 'Explain this' } });
    if (method === 'button') fireEvent.click(page.getByRole('button', { name: 'Send' }));
    else fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toMatchObject({
      text: 'Explain this',
      workspaceReferences: [{ objectId: 'A', contentVersion: 1 }],
    });
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(draft.getSnapshot().workspaceReferences).toEqual([]);
    fireEvent.click(page.getByText('Select B'));
    await act(async () => acknowledge());
    expect(draft.getSnapshot().workspaceReferences).toEqual([{ objectId: 'B', contentVersion: 1 }]);
    expect(commands).toHaveLength(1);
  },
);

it('keeps HTTP queue submission, IME/newline handling and server-owned stopping during an active run', async () => {
  const commands: unknown[] = [];
  let stopped = false;
  const stop = vi.fn();
  const page = mount((path, init) => {
    if (path.includes('/snapshot'))
      return Promise.resolve(
        Response.json(
          snapshotFixture({
            entries: [],
            pending: stopped ? [] : [{ operationId: 'running', status: 'running' }],
            stopping: false,
          }),
        ),
      );
    if (path.includes('/events'))
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"RUN_STARTED","threadId":"main","runId":"running"}\n\n',
                ),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    if (path.endsWith('/runs')) {
      commands.push(JSON.parse(init!.body as string));
      return Promise.resolve(Response.json({ accepted: true }));
    }
    if (path.includes('/stop')) {
      stopped = true;
      stop();
      return Promise.resolve(Response.json({ ok: true }));
    }
  });
  const input = page.getByLabelText('Message');
  await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
  fireEvent.change(input, { target: { value: 'Follow up' } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  expect(commands).toEqual([]);
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(commands).toHaveLength(1));
  const stopButton = await page.findByRole('button', {
    name: 'Stop and withdraw queued tasks',
  });
  await waitFor(() => expect(stopButton.hasAttribute('disabled')).toBe(false));
  fireEvent.click(stopButton);
  await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(commands).toHaveLength(1);
});

it('keeps the composer and viewport mounted when scenario metadata arrives after the chat', async () => {
  let finish!: (response: Response) => void;
  const page = mount((path) => {
    if (path.includes('/scenarios/chat/'))
      return new Promise((resolve) => {
        finish = resolve;
      });
  });
  const input = page.getByLabelText('Message');
  const viewport = page.container.querySelector('[data-slot="chat-viewport"]');
  await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
  fireEvent.change(input, { target: { value: 'Unsent notes' } });
  await act(async () =>
    finish(
      Response.json({
        id: 'scene',
        mainChatId: 'main',
        kind: 'agent',
        workspaceId: 'workspace',
        title: 'Main',
        updatedAt: 1,
      }),
    ),
  );
  await waitFor(() =>
    expect(clients.at(-1)!.getQueryData(['user', 'owner', 'instance', 'main'])).toBeDefined(),
  );
  expect(page.getByLabelText('Message')).toBe(input);
  expect(page.container.querySelector('[data-slot="chat-viewport"]')).toBe(viewport);
  expect((input as HTMLTextAreaElement).value).toBe('Unsent notes');
});

it.each(['untouched', 'text', 'references', 'config'] as const)(
  'restores a failed send only if the cleared draft is untouched (%s)',
  async (change) => {
    let fail!: () => void;
    const commands: { runId: string }[] = [];
    const page = mount((path, init) => {
      if (path.endsWith('/runs')) {
        commands.push(JSON.parse(init!.body as string));
        return new Promise((resolve) => {
          fail = () =>
            resolve(
              Response.json(
                { error: { code: 'unavailable', message: 'Lost receipt' } },
                { status: 503 },
              ),
            );
        });
      }
    });
    const input = page.getByLabelText('Message') as HTMLTextAreaElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    const references = [{ objectId: 'A', contentVersion: 1 }];
    await act(async () => draft.restore({ text: 'Original', workspaceReferences: references }));
    fireEvent.click(page.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(input.value).toBe('');
    if (change === 'text') fireEvent.change(input, { target: { value: 'New draft' } });
    if (change === 'references') fireEvent.click(page.getByText('Select B'));
    if (change === 'config')
      await act(async () =>
        draft.setConfig({ provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off' }),
      );
    await act(async () => fail());
    await page.findByRole('button', { name: 'Retry submission' });
    expect(input.value).toBe(
      change === 'untouched' ? 'Original' : change === 'text' ? 'New draft' : '',
    );
    expect(draft.getSnapshot().workspaceReferences).toEqual(
      change === 'untouched'
        ? references
        : change === 'references'
          ? [{ objectId: 'B', contentVersion: 1 }]
          : [],
    );
    fireEvent.click(page.getByRole('button', { name: 'Retry submission' }));
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]).toEqual(commands[0]);
    await act(async () => fail());
  },
);

it('keeps newly typed text when a successful acknowledgement arrives', async () => {
  let acknowledge!: () => void;
  const page = mount((path) =>
    path.endsWith('/runs')
      ? new Promise((resolve) => {
          acknowledge = () => resolve(Response.json({ accepted: true }));
        })
      : undefined,
  );
  const input = page.getByLabelText('Message') as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: 'First message' } });
  fireEvent.click(page.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(input.value).toBe(''));
  fireEvent.change(input, { target: { value: 'Next message' } });
  await act(async () => acknowledge());
  expect(input.value).toBe('Next message');
});

it('clears the first message before creation and admission acknowledge', async () => {
  let created!: () => void;
  let admitted!: () => void;
  const page = mount((path) => {
    if (path === '/api/conversations')
      return new Promise((resolve) => {
        created = () => resolve(Response.json({ id: 'created' }));
      });
    if (path.endsWith('/runs'))
      return new Promise((resolve) => {
        admitted = () => resolve(Response.json({ accepted: true }));
      });
  }, '');
  const input = page.getByLabelText('Message') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Hello Coach' } });
  await waitFor(() =>
    expect(page.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false),
  );
  fireEvent.click(page.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(created).toBeTypeOf('function'));
  expect(input.value).toBe('');
  await act(async () => created());
  await waitFor(() => expect(admitted).toBeTypeOf('function'));
  expect(input.value).toBe('');
  await act(async () => admitted());
});

it('confirms the restored draft when explicit retry succeeds', async () => {
  const commands: unknown[] = [];
  const page = mount((path, init) => {
    if (path.endsWith('/runs')) {
      commands.push(JSON.parse(init!.body as string));
      return Promise.resolve(
        commands.length === 1
          ? Response.json(
              { error: { code: 'unavailable', message: 'Lost receipt' } },
              { status: 503 },
            )
          : Response.json({ accepted: true }),
      );
    }
  });
  const input = page.getByLabelText('Message') as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: 'Retry this' } });
  fireEvent.click(page.getByRole('button', { name: 'Send' }));
  const retry = await page.findByRole('button', { name: 'Retry submission' });
  expect(input.value).toBe('Retry this');
  fireEvent.click(retry);
  await waitFor(() => expect(page.queryByRole('button', { name: 'Retry submission' })).toBeNull());
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(input.value).toBe('');
});

it('preserves a new message across a deferred explicit retry and blocks duplicate retry clicks', async () => {
  const commands: unknown[] = [];
  let complete!: () => void;
  const page = mount((path, init) => {
    if (!path.endsWith('/runs')) return;
    commands.push(JSON.parse(init!.body as string));
    if (commands.length === 1)
      return Promise.resolve(
        Response.json({ error: { code: 'unavailable', message: 'Lost receipt' } }, { status: 503 }),
      );
    return new Promise((resolve) => {
      complete = () => resolve(Response.json({ accepted: true }));
    });
  });
  const input = page.getByLabelText('Message') as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  fireEvent.change(input, { target: { value: 'Original' } });
  fireEvent.click(page.getByRole('button', { name: 'Send' }));
  const retry = await page.findByRole('button', { name: 'Retry submission' });
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => expect(commands).toHaveLength(2));
  expect(input.value).toBe('');
  fireEvent.change(input, { target: { value: 'Next message' } });
  await act(async () => complete());
  expect(input.value).toBe('Next message');
  expect(commands[1]).toEqual(commands[0]);
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ComposerDraftsProvider } from '../../src/browser/workbench/composer-drafts';
import { WorkspaceProvider, useWorkspace } from '../../src/browser/workspace/provider';
vi.mock('../../src/browser/extensions/extension-loading', () => ({
  useBrowserExtensions: () => ({ loaded: { data: { modules: [] } } }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('keeps uncertain commands in their original project across navigation and retries', async () => {
  vi.stubGlobal(
    'EventSource',
    class {
      close() {}
      addEventListener() {}
    },
  );
  let rejectA!: (error: Error) => void;
  const posts: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const path = String(input);
      if (path.includes('/scenarios/chat/')) {
        const id = path.split('/').at(-1);
        return Response.json({
          id,
          kind: 'canvas',
          workspaceId: id,
          mainChatId: id,
          title: id,
          updatedAt: 1,
        });
      }
      if (path.endsWith('/read'))
        return Response.json({ objects: [], assets: [], operations: [], watermark: 0 });
      if (path.endsWith('/execute')) {
        posts.push({ path, body: JSON.parse(init!.body as string) });
        if (posts.length === 1)
          return await new Promise<Response>((_, reject) => {
            rejectA = reject;
          });
        return Response.json({ status: 'accepted', objectIds: ['node'], operationId: 'b-job' });
      }
      throw new Error(path);
    }),
  );
  function Child() {
    const w = useWorkspace()!;
    return (
      <>
        <span>project:{w.instance?.id}</span>
        <button
          onClick={() =>
            void w
              .execute('canvas.generate', {
                prompt: 'original A prompt',
                title: 'A image',
                aspectRatio: '1:1',
                resolution: '1K',
              })
              .catch(() => {})
          }
        >
          Generate
        </button>
      </>
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (chatId: string) => (
    <QueryClientProvider client={client}>
      <ComposerDraftsProvider userId="owner">
        <WorkspaceProvider userId="owner" chatId={chatId}>
          <Child />
        </WorkspaceProvider>
      </ComposerDraftsProvider>
    </QueryClientProvider>
  );
  const page = render(ui('A'));
  await page.findByText('project:A');
  fireEvent.click(page.getByText('Generate'));
  await waitFor(() => expect(rejectA).toBeTypeOf('function'));
  page.rerender(ui('B'));
  await page.findByText('project:B');
  await act(async () => rejectA(new Error('Response lost')));
  expect(page.queryByText('Retry same operation')).toBeNull();
  expect(page.queryByText('Response lost')).toBeNull();
  expect(posts).toHaveLength(1);
  page.rerender(ui('A'));
  await page.findByText('project:A');
  fireEvent.click(await page.findByText('Retry same operation'));
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts.map((p) => p.path)).toEqual([
    '/api/scenarios/A/workspace/execute',
    '/api/scenarios/A/workspace/execute',
  ]);
  expect(posts[1].body).toEqual(posts[0].body);
  page.unmount();
  client.clear();
});
it('preserves a newer reference selection when the earlier send is acknowledged', async () => {
  const { ComposerDraft } = await import('../../src/browser/workbench/composer-drafts');
  const draft = new ComposerDraft();
  draft.edit('Explore');
  draft.setWorkspaceReferences([{ objectId: 'A', contentVersion: 1 }]);
  const submittedVersion = draft.getSnapshot().version;
  draft.setWorkspaceReferences([{ objectId: 'B', contentVersion: 1 }]);
  expect(draft.getSnapshot().version).toBeGreaterThan(submittedVersion);
  draft.clearText(submittedVersion);
  expect(draft.getSnapshot().workspaceReferences).toEqual([{ objectId: 'B', contentVersion: 1 }]);
});

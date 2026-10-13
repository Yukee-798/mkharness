// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ModelSettingsDialog } from '../../src/browser/ModelSettings';
import { userKeys } from '../../src/browser/queries';
const metadata = {
  provider: 'openai',
  currentId: null,
  configured: false,
  updatedAt: null,
  effectiveSource: 'none',
  serverDefaultAllowed: false,
};
const data = {
  providers: [
    { id: 'openai', name: 'OpenAI' },
    { id: 'deepseek', name: 'DeepSeek' },
  ],
  modelCatalog: {
    models: [],
    defaultSelection: { provider: 'openai', modelId: 'gpt-5-mini', thinkingLevel: 'low' },
  },
  credentials: [metadata, { ...metadata, provider: 'deepseek' }],
  credentialStorageReady: true,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('keeps plaintext outside Query and storage, retains a failed draft and clears it on close', async () => {
  let writes = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'PUT') {
      writes++;
      return writes === 1
        ? Response.json(
            { error: { code: 'credential_conflict', message: '冲突' } },
            { status: 409 },
          )
        : Response.json({ ...metadata, currentId: crypto.randomUUID(), configured: true });
    }
    return Response.json(data);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    closed = vi.fn();
  const ui = (open: boolean, initialProvider?: string) => (
    <QueryClientProvider client={client}>
      <ModelSettingsDialog
        userId="owner"
        open={open}
        onOpenChange={closed}
        initialProvider={initialProvider}
      />
    </QueryClientProvider>
  );
  const view = render(ui(true, 'deepseek'));
  await waitFor(() => expect(view.queryByLabelText('API Key')).not.toBeNull());
  expect(view.getByLabelText('供应商')).toHaveProperty('value', 'deepseek');
  fireEvent.change(view.getByLabelText('API Key'), { target: { value: 'CANARY-PRIVATE-KEY' } });
  fireEvent.click(view.getByRole('button', { name: '保存 Key' }));
  await waitFor(() => expect(view.queryByText('冲突')).not.toBeNull());
  expect((view.getByLabelText('API Key') as HTMLInputElement).value).toBe('CANARY-PRIVATE-KEY');
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
    ),
  ).not.toContain('CANARY');
  expect(client.getMutationCache().getAll()).toHaveLength(0);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  view.rerender(ui(false));
  view.rerender(ui(true));
  await waitFor(() => expect((view.getByLabelText('API Key') as HTMLInputElement).value).toBe(''));
  expect(view.getByLabelText('供应商')).toHaveProperty('value', 'openai');
  fireEvent.change(view.getByLabelText('API Key'), { target: { value: 'SECOND-PRIVATE-KEY' } });
  await act(async () => {
    client.setQueryData(userKeys('owner').models, {
      ...data,
      modelCatalog: {
        ...data.modelCatalog,
        defaultSelection: { provider: 'deepseek', modelId: 'deepseek-chat', thinkingLevel: 'low' },
      },
    });
  });
  expect(view.getByLabelText('供应商')).toHaveProperty('value', 'openai');
  expect((view.getByLabelText('API Key') as HTMLInputElement).value).toBe('SECOND-PRIVATE-KEY');
});

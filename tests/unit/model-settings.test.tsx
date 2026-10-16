// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsDialog } from '../../src/browser/settings/Settings';
import type { ModelSettings, CredentialMetadata } from '../../src/shared/model-settings';
import { userKeys } from '../../src/browser/queries';
const metadata: CredentialMetadata = {
  provider: 'openai',
  currentId: null,
  baseUrl: null,
  configured: false,
  updatedAt: null,
  effectiveSource: 'none',
  serverDefaultAllowed: false,
};
const data: ModelSettings = {
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      defaultModelId: 'gpt-5-mini',
      baseUrl: 'https://api.openai.com/v1',
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      defaultModelId: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
    },
  ],
  modelCatalog: {
    models: [],
    defaultSelection: { provider: 'openai', modelId: 'gpt-5-mini', thinkingLevel: 'low' },
  },
  credentials: [metadata, { ...metadata, provider: 'deepseek' }],
  credentialStorageReady: true,
};
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('keeps plaintext outside Query and storage, retains a failed draft and clears it on close', async () => {
  let writes = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'PUT') {
      expect(JSON.parse(String(init.body))).toMatchObject({
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'CANARY-PRIVATE-KEY',
      });
      expect(String(_url)).toContain('/model-credentials/deepseek');
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
      <SettingsDialog
        initialSection="models"
        userId="owner"
        open={open}
        onOpenChange={closed}
        initialProvider={initialProvider}
      />
    </QueryClientProvider>
  );
  const view = render(ui(true, 'deepseek'));
  await waitFor(() => expect(view.queryByLabelText('API Key')).not.toBeNull());
  expect(view.queryByRole('combobox')).toBeNull();
  expect(view.getByLabelText('Base URL')).toHaveProperty('value', 'https://api.deepseek.com');
  fireEvent.change(view.getByLabelText('Base URL'), {
    target: { value: 'https://custom.example.com/v1' },
  });
  fireEvent.change(view.getByLabelText('API Key'), { target: { value: 'CANARY-PRIVATE-KEY' } });
  fireEvent.click(view.getByRole('button', { name: 'Save configuration' }));
  await waitFor(() => expect(view.queryByText('冲突')).not.toBeNull());
  expect((view.getByLabelText('API Key') as HTMLInputElement).value).toBe('CANARY-PRIVATE-KEY');
  expect(view.getByLabelText('Base URL')).toHaveProperty('value', 'https://custom.example.com/v1');
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
  expect(view.getByLabelText('Base URL')).toHaveProperty('value', 'https://api.openai.com/v1');
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
  expect(view.getByLabelText('Base URL')).toHaveProperty('value', 'https://api.openai.com/v1');
  expect((view.getByLabelText('API Key') as HTMLInputElement).value).toBe('SECOND-PRIVATE-KEY');
});

it('remembers a successfully saved key only by explicit opt-in and restores the matching version without re-uploading', async () => {
  const id = crypto.randomUUID();
  let saved: ModelSettings = {
    ...data,
    modelCatalog: {
      ...data.modelCatalog,
      defaultSelection: { provider: 'deepseek', modelId: 'deepseek-flash', thinkingLevel: 'low' },
    },
  };
  let writes = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ apiKey: 'LOCAL-CANARY', modelId: 'deepseek-v4-pro' });
      writes++;
      const credential = {
        ...metadata,
        provider: 'deepseek',
        currentId: id,
        modelId: body.modelId,
        configured: true,
      };
      saved = { ...saved, credentials: [metadata, credential] };
      return Response.json(credential);
    }
    return Response.json(saved);
  });
  const ui = (open: boolean) => (
    <QueryClientProvider client={client}>
      <SettingsDialog initialSection="models" userId="owner" open={open} onOpenChange={() => {}} />
    </QueryClientProvider>
  );
  const view = render(ui(true));
  await waitFor(() => expect(view.queryByLabelText('API Key')).not.toBeNull());
  expect(view.getByLabelText('Model name')).toHaveProperty('value', 'deepseek-flash');
  expect(view.getByLabelText('Model name').getAttribute('placeholder')).toBe('deepseek-flash');
  expect(view.queryByRole('button', { name: '移除 Key' })).toBeNull();
  fireEvent.change(view.getByLabelText('Model name'), { target: { value: 'deepseek-v4-pro' } });
  fireEvent.change(view.getByLabelText('API Key'), { target: { value: 'LOCAL-CANARY' } });
  fireEvent.click(view.getByRole('checkbox'));
  fireEvent.click(view.getByRole('button', { name: 'Save configuration' }));
  await waitFor(() =>
    expect(view.queryByText('Saved. Connection has not been verified.')).not.toBeNull(),
  );
  expect(localStorage.length).toBe(1);
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
    ),
  ).not.toContain('LOCAL-CANARY');
  expect(client.getMutationCache().getAll()).toHaveLength(0);
  view.rerender(ui(false));
  view.rerender(ui(true));
  await waitFor(() =>
    expect(view.getByLabelText('API Key')).toHaveProperty('value', 'LOCAL-CANARY'),
  );
  expect(writes).toBe(1);
  fireEvent.click(view.getByRole('checkbox'));
  expect(localStorage.length).toBe(0);
});

it('saves a known endpoint using its native provider and owner-specific revision', async () => {
  const settings: ModelSettings = {
    ...data,
    providers: [
      ...data.providers,
      {
        id: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModelId: 'openrouter/free',
      },
    ],
    modelCatalog: {
      models: [],
      defaultSelection: {
        provider: 'openrouter',
        modelId: 'openrouter/free',
        thinkingLevel: 'off',
      },
    },
    credentials: [
      ...data.credentials,
      {
        ...metadata,
        provider: 'openrouter',
        effectiveSource: 'server',
        serverDefaultAllowed: true,
      },
    ],
  };
  let submitted: { url: string; body: any } | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (init?.method === 'PUT') {
      submitted = { url: String(url), body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          ...metadata,
          provider: 'deepseek',
          currentId: 'saved',
          effectiveSource: 'user',
          configured: true,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(settings), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SettingsDialog initialSection="models" userId="owner" open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(view.getByLabelText('Model name')).toHaveProperty('value', 'openrouter/free'),
  );
  fireEvent.change(view.getByLabelText('Base URL'), {
    target: { value: 'https://api.deepseek.com/' },
  });
  fireEvent.change(view.getByLabelText('Model name'), { target: { value: 'deepseek-flash' } });
  fireEvent.change(view.getByLabelText('API Key'), { target: { value: 'PERSONAL-CANARY' } });
  fireEvent.click(view.getByText('Save configuration'));
  await waitFor(() => expect(submitted?.url).toBe('/api/settings/model-credentials/deepseek'));
  expect(submitted?.body).toMatchObject({
    modelId: 'deepseek-flash',
    expectedCurrentId: null,
    apiKey: 'PERSONAL-CANARY',
  });
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
    ),
  ).not.toContain('PERSONAL-CANARY');
});

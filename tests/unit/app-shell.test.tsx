// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider, localeStorageKey, useLocale } from '../../src/browser/app/locale';
import { App } from '../../src/browser/app/App';

const state = vi.hoisted(() => ({
  route: { chat: '' },
  auth: {
    data: undefined as undefined | { user: { id: string; name: string } },
    isPending: true,
    error: null,
    refetch: vi.fn(),
  },
  navigate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => state.route,
  useNavigate: () => state.navigate,
}));
vi.mock('../../src/browser/app/auth', () => ({ authClient: { useSession: () => state.auth } }));
const clients: QueryClient[] = [];
const models = {
  providers: [],
  credentials: [],
  credentialStorageReady: true,
  modelCatalog: {
    models: [{ id: 'fixture', name: 'Fixture', provider: 'fixture', thinkingLevels: ['off'] }],
    defaultSelection: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off' },
  },
};
function application(
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
) {
  if (!clients.includes(client)) clients.push(client);
  return (
    <QueryClientProvider client={client}>
      <LocaleProvider initialLocale="zh-CN">
        <App />
      </LocaleProvider>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input);
      if (path.includes('/settings/models')) return Response.json(models);
      if (path.includes('/capabilities')) return Response.json({ extensionIds: [] });
      if (path.endsWith('/conversations')) return Response.json({ items: [], next: null });
      throw new Error('Unexpected request: ' + path);
    }),
  );
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  state.route.chat = '';
  state.auth.data = undefined;
  state.auth.isPending = true;
  localStorage.clear();
  document.cookie = `${localeStorageKey}=; Max-Age=0; Path=/`;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('does not server render a provisional workspace before the account is known', () => {
  const html = renderToString(application());
  expect(html).toBe('');
  expect(fetch).not.toHaveBeenCalled();
});
it('does not server render a provisional existing chat', () => {
  state.route.chat = 'existing';
  const html = renderToString(application());
  expect(html).toBe('');
  expect(fetch).not.toHaveBeenCalled();
});
it('only shows the directory skeleton during a real directory request and keeps the shell mounted', async () => {
  let completeDirectory!: (response: Response) => void;
  const original = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((input, init) =>
      String(input).endsWith('/conversations')
        ? new Promise<Response>((resolve) => {
            completeDirectory = resolve;
          })
        : original(input, init),
    ),
  );
  const ui = application();
  const page = render(ui);
  expect(page.container.innerHTML).toBe('');
  expect(fetch).not.toHaveBeenCalled();
  state.auth.data = { user: { id: 'owner', name: 'Owner' } };
  state.auth.isPending = false;
  page.rerender(application(clients.at(-1)!));
  const shell = page.container.querySelector('#conversation');
  expect(shell).toBeTruthy();
  expect(page.container.querySelector('[data-slot="chat-welcome"]')).toBeTruthy();
  const loading = await page.findByRole('status', { name: '正在读取目录' });
  expect(loading.closest('aside')).toBeTruthy();
  expect(page.container.querySelector('#conversation [data-slot="skeleton"]')).toBeNull();
  expect(page.container.querySelector('#conversation')).toBe(shell);
  expect(page.container.querySelector('textarea')?.disabled).toBe(false);
  await act(async () => completeDirectory(Response.json({ items: [], next: null })));
  await waitFor(() => expect(page.queryByRole('status', { name: '正在读取目录' })).toBeNull());
  expect(page.container.querySelector('#conversation')).toBe(shell);
});
it('keeps the ready workspace visible during a background session refresh', async () => {
  state.auth.data = { user: { id: 'owner', name: 'Owner' } };
  state.auth.isPending = false;
  const page = render(application());
  const shell = page.container.querySelector('#conversation');
  const composer = page.container.querySelector('textarea');
  await waitFor(() => expect(composer?.disabled).toBe(false));
  state.auth.isPending = true;
  page.rerender(application(clients.at(-1)!));
  expect(page.container.querySelector('#conversation')).toBe(shell);
  expect(page.container.querySelector('textarea')).toBe(composer);
  expect(page.getByRole('button', { name: '账号：Owner' })).toBeTruthy();
});
it('restores messages inside the real chat without replacing its composer or shell', async () => {
  state.auth.data = { user: { id: 'owner', name: 'Owner' } };
  state.auth.isPending = false;
  state.route.chat = 'existing';
  let complete!: (response: Response) => void;
  const original = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((input, init) =>
      String(input).includes('/snapshot')
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : original(input, init),
    ),
  );
  const page = render(application());
  const shell = page.container.querySelector('#conversation');
  const composer = page.container.querySelector('textarea');
  expect(composer?.disabled).toBe(true);
  expect(
    page.container.querySelector('[data-slot="chat-viewport"]')?.getAttribute('aria-busy'),
  ).toBe('true');
  expect(page.container.querySelector('#conversation [data-slot="skeleton"]')).toBeNull();
  expect(page.container.querySelector('[data-slot="chat-welcome"]')).toBeNull();
  await waitFor(() => expect(complete).toBeTypeOf('function'));
  await act(async () =>
    complete(
      Response.json({
        conversationId: 1,
        entries: [
          {
            id: 1,
            conversationId: 1,
            kind: 'pi.user',
            model: [{ role: 'user', content: [{ type: 'text', text: 'Saved message' }] }],
          },
        ],
        pending: [],
        queue: [],
        queueEdits: [],
        stopping: false,
        history: { upperEntryId: 1, revision: 0, annotations: {} },
      }),
    ),
  );
  await page.findByText('Saved message');
  expect(page.container.querySelector('#conversation')).toBe(shell);
  expect(page.container.querySelector('textarea')).toBe(composer);
  expect(composer?.disabled).toBe(false);
  expect(
    page.container.querySelector('[data-slot="chat-viewport"]')?.getAttribute('aria-busy'),
  ).toBe('false');
});
it('resets private composer drafts on account changes while retaining the shell', async () => {
  state.auth.data = { user: { id: 'owner', name: 'Owner' } };
  state.auth.isPending = false;
  const ui = application();
  const page = render(ui);
  const shell = page.container.querySelector('#conversation');
  fireEvent.change(page.getByRole('textbox', { name: '消息' }), {
    target: { value: 'Private draft' },
  });
  state.auth.data = { user: { id: 'other-owner', name: 'Other owner' } };
  page.rerender(application(clients.at(-1)!));
  await page.findByRole('button', { name: '账号：Other owner' });
  expect(page.container.querySelector('textarea')?.value).toBe('');
  expect(page.container.querySelector('#conversation')).toBe(shell);
});
function Language() {
  return <span>{useLocale().locale}</span>;
}
it('migrates a saved language into the server-rendering cookie', () => {
  localStorage.setItem(localeStorageKey, 'zh-CN');
  expect(
    renderToString(
      <LocaleProvider initialLocale="en">
        <Language />
      </LocaleProvider>,
    ),
  ).toContain('en');
  const page = render(
    <LocaleProvider initialLocale="en">
      <Language />
    </LocaleProvider>,
  );
  expect(page.getByText('zh-CN')).toBeTruthy();
  expect(document.cookie).toContain(`${localeStorageKey}=zh-CN`);
});

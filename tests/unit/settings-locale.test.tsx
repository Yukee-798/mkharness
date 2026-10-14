// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider, localeStorageKey, useLocale } from '../../src/browser/locale';
import { SettingsDialog } from '../../src/browser/Settings';
import { Chat } from '../../src/browser/Chat';
import { Button } from '../../src/browser/ui/button';
const settings = {
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      defaultModelId: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
    },
  ],
  modelCatalog: {
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek', provider: 'deepseek', thinkingLevels: ['off'] },
    ],
    defaultSelection: { provider: 'deepseek', modelId: 'deepseek-flash', thinkingLevel: 'off' },
  },
  credentials: [
    {
      provider: 'deepseek',
      currentId: null,
      baseUrl: null,
      configured: false,
      updatedAt: null,
      effectiveSource: 'none',
      serverDefaultAllowed: false,
    },
  ],
  credentialStorageReady: true,
};
function SwitchLanguage() {
  const { setLocale } = useLocale();
  return (
    <>
      <Button onClick={() => setLocale('zh-CN')}>Use Chinese</Button>
      <Button onClick={() => setLocale('en')}>Use English</Button>
    </>
  );
}
beforeEach(() => {
  localStorage.clear();
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
it('defaults to English, persists the chosen language, and handles unavailable storage', async () => {
  const view = render(
    <LocaleProvider>
      <SwitchLanguage />
      <SettingsDialog userId="owner" open onOpenChange={() => {}} />
    </LocaleProvider>,
  );
  expect(view.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  expect(view.getByRole('tab', { name: 'General' })).toBeTruthy();
  expect(document.documentElement.lang).toBe('en');
  fireEvent.click(view.getByText('Use Chinese'));
  expect(view.getByRole('dialog', { name: '设置' })).toBeTruthy();
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(localStorage.getItem(localeStorageKey)).toBe('zh-CN');
  view.unmount();
  const next = render(
    <LocaleProvider>
      <SwitchLanguage />
      <SettingsDialog userId="owner" open onOpenChange={() => {}} />
    </LocaleProvider>,
  );
  expect(next.getByRole('tab', { name: '通用' })).toBeTruthy();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  fireEvent.click(next.getByText('Use English'));
  expect(next.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  expect(document.documentElement.lang).toBe('en');
});
it('does not read model settings just to open General, and synchronizes language changes from another tab', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const view = render(
    <LocaleProvider>
      <SettingsDialog userId="owner" open onOpenChange={() => {}} />
    </LocaleProvider>,
  );
  expect(fetch).not.toHaveBeenCalled();
  localStorage.setItem(localeStorageKey, 'zh-CN');
  fireEvent(window, new StorageEvent('storage', { key: localeStorageKey, newValue: 'zh-CN' }));
  expect(view.getByRole('dialog', { name: '设置' })).toBeTruthy();
});
it('preserves composer and credential drafts across language changes without writes or refetch', async () => {
  const requests: { url: string; method: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET' });
    return Response.json(settings);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <LocaleProvider>
      <QueryClientProvider client={client}>
        <SwitchLanguage />
        <Chat id="" userId="owner" />
        <SettingsDialog initialSection="models" userId="owner" open onOpenChange={() => {}} />
      </QueryClientProvider>
    </LocaleProvider>,
  );
  await waitFor(() => expect(view.queryByLabelText('API Key')).not.toBeNull());
  const composer = view.getByLabelText('Message');
  const key = view.getByLabelText('API Key');
  fireEvent.change(composer, { target: { value: 'Unsent message' } });
  fireEvent.change(key, { target: { value: 'UNSAVED-CANARY' } });
  const before = requests.length;
  fireEvent.click(view.getByText('Use Chinese'));
  expect(view.getByLabelText('消息')).toBe(composer);
  expect(composer).toHaveProperty('value', 'Unsent message');
  expect(view.getByLabelText('API Key')).toBe(key);
  expect(key).toHaveProperty('value', 'UNSAVED-CANARY');
  expect(requests).toHaveLength(before);
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
    ),
  ).not.toContain('UNSAVED-CANARY');
  expect(localStorage.getItem(localeStorageKey)).toBe('zh-CN');
  expect(localStorage.length).toBe(1);
  client.clear();
});

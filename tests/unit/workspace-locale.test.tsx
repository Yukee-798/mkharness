// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider, useLocale, localeStorageKey } from '../../src/browser/app/locale';
import { ComposerDraftsProvider } from '../../src/browser/workbench/composer-drafts';
import { ProjectDirectory } from '../../src/browser/workspace/projects';
import { ApiError } from '../../src/browser/api';
import { workspaceError } from '../../src/browser/workspace/error';
import { translate } from '../../src/browser/app/locale';

const workspace = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../src/browser/workspace/provider', () => ({ useWorkspace: () => workspace.current }));
import CanvasView from '../../src/scenarios/canvas/View';
import ReportView from '../../src/scenarios/reports/View';

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
function SwitchLanguage() {
  const { locale, setLocale } = useLocale();
  return (
    <button onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>Switch language</button>
  );
}

it('switches project/canvas labels and an open creation form without losing its draft or submitting it', async () => {
  const execute = vi.fn();
  workspace.current = {
    instance: { id: 'project', mainChatId: 'chat' },
    snapshot: { objects: [], assets: [], operations: [], canUndo: false, canRedo: false },
    execute,
    connected: true,
    busy: false,
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ items: [] }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = render(
    <LocaleProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <ComposerDraftsProvider userId="owner">
          <SwitchLanguage />
          <ProjectDirectory userId="owner" choose={() => {}} />
          <CanvasView />
        </ComposerDraftsProvider>
      </QueryClientProvider>
    </LocaleProvider>,
  );
  expect(page.getByRole('button', { name: 'New creative project' })).toBeDefined();
  expect(page.getByLabelText('Undo')).toHaveProperty('disabled', true);
  fireEvent.click(page.getByRole('button', { name: 'Generate image' }));
  const title = page.getByLabelText('Name');
  const prompt = page.getByLabelText('Image description');
  fireEvent.change(title, { target: { value: '我的创作' } });
  fireEvent.change(prompt, { target: { value: 'A robot in the rain' } });
  localStorage.setItem(localeStorageKey, 'zh-CN');
  fireEvent(window, new StorageEvent('storage', { key: localeStorageKey, newValue: 'zh-CN' }));
  expect(page.getByRole('dialog', { name: '生成图片' })).toBeDefined();
  expect(page.getByLabelText('名称')).toBe(title);
  expect(title).toHaveProperty('value', '我的创作');
  expect(page.getByLabelText('图片描述')).toBe(prompt);
  expect(prompt).toHaveProperty('value', 'A robot in the rain');
  expect(page.getByLabelText('图片比例')).toBeDefined();
  expect(execute).not.toHaveBeenCalled();
  page.unmount();
  client.clear();
});

it('switches report chrome and an existing export error without refetching or modifying the report', async () => {
  const read = vi.fn(() => new Promise(() => {})),
    execute = vi.fn();
  workspace.current = {
    instance: { id: 'project' },
    snapshot: {
      objects: [
        {
          id: 'R',
          type: 'report',
          title: '用户报告标题',
          version: 1,
          contentVersion: 1,
          data: { revision: 1 },
        },
      ],
    },
    read,
    execute,
    openObject: vi.fn(),
    setOpen: vi.fn(),
    connected: true,
  };
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 409 }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = render(
    <LocaleProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <SwitchLanguage />
        <ReportView />
      </QueryClientProvider>
    </LocaleProvider>,
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  fireEvent.click(page.getByRole('button', { name: 'Download HTML' }));
  await page.findByText('Could not export the report. Check its image assets and retry.');
  expect(String(fetch.mock.calls[0][0])).toContain('locale=en');
  fireEvent.click(page.getByText('Switch language'));
  expect(page.getByText('报告导出失败，请检查图片素材后重试')).toBeDefined();
  expect(page.getByLabelText('报告版本')).toBeDefined();
  expect(page.getByText('用户报告标题')).toBeDefined();
  expect(read).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  page.unmount();
  client.clear();
});

it('uses stable API error codes for translated errors, retaining unknown diagnostics', () => {
  const key = workspaceError(new ApiError(409, 'workspace_conflict', '服务端中文提示'));
  expect(translate('en', key)).toBe('This content changed. Select it again and retry.');
  expect(translate('zh-CN', key)).toContain('内容已更新');
  expect(workspaceError(new Error('Provider-specific diagnostic'))).toBe(
    'Provider-specific diagnostic',
  );
});

it('translates system-default project names while keeping the same user-defined name verbatim', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      items: [
        { id: 'default', title: '未命名创作', titleCustom: false },
        { id: 'custom', title: '未命名创作', titleCustom: true },
      ],
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = render(
    <LocaleProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <ProjectDirectory userId="owner" choose={() => {}} />
      </QueryClientProvider>
    </LocaleProvider>,
  );
  await page.findByRole('button', { name: 'Untitled project' });
  expect(page.getByRole('button', { name: '未命名创作' })).toBeDefined();
  expect(page.getByLabelText('Project actions: Untitled project')).toBeDefined();
  page.unmount();
  client.clear();
});

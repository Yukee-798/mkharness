// @vitest-environment jsdom
import { expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const state = vi.hoisted(() => ({ w: {} as Record<string, unknown> }));
vi.mock('../../src/browser/workspace/provider', () => ({ useWorkspace: () => state.w }));
import ReportView from '../../src/scenarios/reports/View';
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});
it('opens the current version when another report is opened from a message card', async () => {
  const read = vi.fn(() => new Promise(() => {}));
  state.w = {
    instance: { id: 'scenario' },
    snapshot: {
      objects: [
        { id: 'A', type: 'report', contentVersion: 4, data: { revision: 4 }, title: 'A' },
        { id: 'B', type: 'report', contentVersion: 1, data: { revision: 1 }, title: 'B' },
      ],
    },
    activeObjectId: 'A',
    read,
    openObject: vi.fn(),
    setOpen: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={client}>
      <ReportView />
    </QueryClientProvider>
  );
  const page = render(ui());
  await waitFor(() => expect(read).toHaveBeenCalledWith('report', { id: 'A' }));
  fireEvent.keyDown(page.getByRole('combobox', { name: 'Report version' }), { key: 'ArrowDown' });
  fireEvent.click(await page.findByRole('option', { name: 'v3' }));
  await waitFor(() => expect(read).toHaveBeenCalledWith('report', { id: 'A', revision: 3 }));
  state.w = { ...state.w, activeObjectId: 'B' };
  page.rerender(ui());
  await waitFor(() => expect(read).toHaveBeenCalledWith('report', { id: 'B' }));
  expect(read).not.toHaveBeenCalledWith('report', { id: 'B', revision: 3 });
  fireEvent.keyDown(page.getByRole('combobox', { name: 'Switch report' }), { key: 'ArrowDown' });
  fireEvent.click(await page.findByRole('option', { name: 'A' }));
  expect(state.w.openObject).toHaveBeenCalledWith('A');
  page.unmount();
  client.clear();
});

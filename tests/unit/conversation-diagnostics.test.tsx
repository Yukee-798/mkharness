// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { ConversationError } from '../../src/browser/chat/ConversationError';
import {
  conversationDiagnostics,
  conversationDiagnosticsKey,
  recordConversationStoreError,
  traceConversation,
} from '../../src/browser/chat/session/diagnostics';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it('retains bounded lifecycle evidence and the exact store stack across a reload', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState(null, '', '/?chat=chat-a&scenario=scene-a&token=must-not-store');
  for (let i = 0; i < 100; i++)
    traceConversation('stream.event', { type: 'TEXT_MESSAGE_START', sequence: i });
  const error = new Error('Entry not available in the store');
  recordConversationStoreError(error);
  const saved = JSON.parse(sessionStorage.getItem(conversationDiagnosticsKey)!);
  expect(saved.at(-1).stacks).toEqual([error.stack]);
  expect(saved.at(-1).route).toEqual({ path: '/', chat: 'chat-a', scenario: 'scene-a' });
  expect(saved.at(-1).trace).toHaveLength(60);
  expect(saved.at(-1).trace[0].detail.sequence).toBe(40);
  expect(JSON.stringify(saved)).not.toContain('must-not-store');

  // Reload the diagnostics module, as a page refresh does, without clearing tab storage.
  vi.resetModules();
  const reloaded = await import('../../src/browser/chat/session/diagnostics');
  expect(JSON.parse(reloaded.conversationDiagnostics()).failures).toEqual(saved);
  for (let i = 0; i < 8; i++) reloaded.recordConversationStoreError(error);
  expect(JSON.parse(sessionStorage.getItem(conversationDiagnosticsKey)!)).toHaveLength(4);
});

it('does not persist unrelated errors and tolerates blocked browser storage', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  recordConversationStoreError(new Error('Private upstream provider failure'));
  expect(sessionStorage.getItem(conversationDiagnosticsKey)).toBeNull();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Denied');
  });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Denied');
  });
  const error = new AggregateError(
    [new Error('Entry not available in the store')],
    'Subscribers failed',
  );
  expect(() => recordConversationStoreError(error)).not.toThrow();
  expect(conversationDiagnostics()).toContain('Entry not available in the store');
});

it('offers an explicit view reset without resubmitting or stopping server work', () => {
  const reset = vi.fn();
  const fetch = vi.spyOn(globalThis, 'fetch');
  const view = render(
    <ConversationError error={new Error('Entry not available in the store')} reset={reset} />,
  );
  fireEvent.click(view.getByRole('button', { name: 'Reopen conversation' }));
  expect(reset).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: 'Copy diagnostics' })).toBeTruthy();
});

it('uses the shared shadcn recovery UI for other route errors without displaying raw details', () => {
  const reset = vi.fn();
  const page = render(
    <ConversationError error={new Error('private upstream detail')} reset={reset} />,
  );
  const retry = page.getByRole('button', { name: 'Reopen page' });
  expect(retry.getAttribute('data-slot')).toBe('button');
  expect(page.queryByText('private upstream detail')).toBeNull();
  expect(page.queryByRole('button', { name: 'Copy diagnostics' })).toBeNull();
  fireEvent.click(retry);
  expect(reset).toHaveBeenCalledOnce();
});

it('captures a real router-caught exception before the recovery action resets the view', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  let fail = true;
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => {
      if (fail) throw new Error('Entry not available in the store');
      return <p>Restored view</p>;
    },
    onCatch: recordConversationStoreError,
    errorComponent: ConversationError,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const page = render(<RouterProvider router={router} />);
  await page.findByRole('button', { name: 'Reopen conversation' });
  expect(sessionStorage.getItem(conversationDiagnosticsKey)).toContain(
    'Entry not available in the store',
  );
  fail = false;
  fireEvent.click(page.getByRole('button', { name: 'Reopen conversation' }));
  await page.findByText('Restored view');
  expect(sessionStorage.getItem(conversationDiagnosticsKey)).toContain(
    'Entry not available in the store',
  );
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Chat } from '../../src/browser/Chat';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps an unconfigured new chat local rather than reconnecting an empty conversation ID', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const requests: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/capabilities') return Response.json({ extensionIds: [] });
    if (path === '/api/settings/models')
      return Response.json({
        modelCatalog: {
          models: [
            {
              provider: 'deepseek',
              id: 'deepseek-flash',
              name: 'DeepSeek V4.1 Flash',
              thinkingLevels: ['low'],
            },
          ],
          defaultSelection: {
            provider: 'deepseek',
            modelId: 'deepseek-flash',
            thinkingLevel: 'low',
          },
        },
        credentials: [{ provider: 'deepseek', effectiveSource: 'none' }],
      });
    return new Response('404 Not Found', { status: 404 });
  });
  const client = new QueryClient();
  const settings = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <Chat id="" userId="keyless" onSettings={settings} />
    </QueryClientProvider>,
  );
  try {
    await waitFor(() =>
      expect(client.getQueryData(['user', 'keyless', 'model-settings'])).toBeDefined(),
    );
    fireEvent.change(view.getByLabelText('Message'), { target: { value: '你好' } });
    fireEvent.submit(view.getByLabelText('Message').closest('form')!);
    await waitFor(() =>
      expect(view.getByRole('alert').textContent).toContain('Configure the Base URL'),
    );
    // Reproduce the previously offered recovery action, if it is still present.
    const reconnect = view.queryByRole('button', { name: 'Reconnect' });
    if (reconnect) fireEvent.click(reconnect);
    await waitFor(() => expect(view.getByRole('alert').textContent).not.toContain('JSON'));
    expect(requests.filter((path) => path.includes('/conversations'))).toEqual([]);
    expect(view.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Configure model & API key' }));
    expect(settings).toHaveBeenCalledWith('deepseek');
    expect((view.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('你好');
  } finally {
    client.clear();
  }
});

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { useExtensionConfig } from '../../src/browser/extension-config';
import { browserLoaders } from '../../src/extensions/browser';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('retries a partial module load without replacing the surrounding runtime or successful decorations', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ extensionIds: ['web', 'example'] }),
  );
  const web = vi.spyOn(browserLoaders, 'web').mockResolvedValue({ toolkit: {} });
  const example = vi
    .spyOn(browserLoaders, 'example')
    .mockRejectedValueOnce(new Error('temporary module outage'))
    .mockResolvedValue({ toolkit: { describe_text: { type: 'backend', render: () => null } } });
  function App() {
    const extensions = useExtensionConfig('owner');
    const [draft, setDraft] = useState('');
    return (
      <>
        <input
          aria-label="draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p>{extensions.unavailable ? 'unavailable' : 'ready'}</p>
        <p>{Object.keys(extensions.toolkit).join(',')}</p>
        <button onClick={extensions.retry}>retry</button>
      </>
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(view.queryByText('unavailable')).not.toBeNull());
  const input = view.getByLabelText('draft');
  fireEvent.change(input, { target: { value: 'retain draft' } });
  fireEvent.click(view.getByText('retry'));
  await waitFor(() => expect(view.queryByText('describe_text')).not.toBeNull());
  expect(view.queryByText('unavailable')).toBeNull();
  expect(view.getByLabelText('draft')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('retain draft');
  expect(example).toHaveBeenCalledTimes(2);
  expect(web).toHaveBeenCalledTimes(2); // Native import returns the already evaluated successful module.
  cleanup();
  client.clear();
});

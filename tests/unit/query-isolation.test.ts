import { expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { directoryOptions } from '../../src/browser/queries';

it('private reads are scoped to the account and clear on logout', async () => {
  const client = new QueryClient();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  try {
    fetcher.mockResolvedValueOnce(
      Response.json({ items: [{ id: 'a', title: 'private', updated_at: 1 }], next: null }),
    );
    await client.fetchInfiniteQuery(directoryOptions('alice'));
    fetcher.mockResolvedValueOnce(Response.json({ items: [], next: null }));
    const bob = await client.fetchInfiniteQuery(directoryOptions('bob'));
    expect(bob.pages[0].items).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.clear();
    expect(client.getQueryCache().getAll()).toEqual([]);
  } finally {
    fetcher.mockRestore();
  }
});

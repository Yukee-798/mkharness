import { useQuery } from '@tanstack/react-query';
import { request } from '../api';
import { loadBrowserExtensions } from './extensions';
import { browserLoaders } from '../../extensions/browser';

/** Shared discovery/download cache; no dependency on the chat runtime. */
export function useBrowserExtensions(userId: string) {
  const capabilities = useQuery({
    queryKey: ['user', userId, 'capabilities'],
    queryFn: ({ signal }) =>
      request<{ extensionIds: string[]; customMcp?: boolean; skills?: boolean }>('/capabilities', {
        signal,
      }),
    retry: false,
    enabled: !!userId,
    // Deployment capabilities do not change between workspace/runtime mounts.
    // Recheck on focus so an already open page can still observe a redeployment.
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
  });
  const ids = capabilities.data?.extensionIds ?? [];
  const loaded = useQuery({
    queryKey: ['user', userId, 'browser-extensions', ids],
    queryFn: () => loadBrowserExtensions(ids, browserLoaders),
    enabled: !!userId && !!capabilities.data,
    retry: false,
    // Partial success is usable but not permanently fresh. A focus or explicit
    // retry may recover a transient chunk failure without reloading the chat.
    staleTime: (query) => (query.state.data?.unavailable.length ? 0 : Infinity),
  });
  return { capabilities, loaded };
}

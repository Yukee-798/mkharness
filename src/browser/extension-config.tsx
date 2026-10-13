import { AuiConfig, Tools } from '@assistant-ui/react';
import { useQuery } from '@tanstack/react-query';
import { request } from './api';
import { loadBrowserExtensions } from './extensions';
import { browserLoaders } from '../extensions/browser';
import { useMemo } from 'react';
export function useExtensionConfig(userId: string) {
  const capabilities = useQuery({
    queryKey: ['user', userId, 'capabilities'],
    queryFn: ({ signal }) => request<{ extensionIds: string[] }>('/capabilities', { signal }),
    retry: false,
  });
  const ids = capabilities.data?.extensionIds ?? [];
  const loaded = useQuery({
    queryKey: ['user', userId, 'browser-extensions', ids],
    queryFn: () => loadBrowserExtensions(ids, browserLoaders),
    enabled: !!capabilities.data,
    retry: false,
    // Partial success is usable but not permanently fresh. A focus or explicit
    // retry may recover a transient chunk failure without reloading the chat.
    staleTime: (query) => (query.state.data?.unavailable.length ? 0 : Infinity),
  });
  const config = useMemo(() => {
    const toolkit = Object.assign(
      {},
      ...(loaded.data?.modules ?? []).map((module) => module.toolkit),
    );
    const activity = Object.assign(
      {},
      ...(loaded.data?.modules ?? []).map((module) => module.activity),
    );
    const ui = (loaded.data?.modules ?? []).flatMap(({ id, ui }) => (ui ? [{ ...ui, id }] : []));
    return { config: AuiConfig({ tools: Tools({ toolkit }) }), toolkit, activity, ui };
  }, [loaded.data]);
  return {
    ...config,
    unavailable: capabilities.isError || !!loaded.data?.unavailable.length,
    loading: capabilities.isFetching || loaded.isFetching,
    retry: () => {
      if (capabilities.isError) void capabilities.refetch();
      else void loaded.refetch();
    },
  };
}

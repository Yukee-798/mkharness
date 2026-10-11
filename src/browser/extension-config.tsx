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
    staleTime: Infinity,
  });
  return useMemo(() => {
    const toolkit = Object.assign(
      {},
      ...(loaded.data?.modules ?? []).map((module) => module.toolkit),
    );
    const activity = Object.assign(
      {},
      ...(loaded.data?.modules ?? []).map((module) => module.activity),
    );
    return { config: AuiConfig({ tools: Tools({ toolkit }) }), activity };
  }, [loaded.data]);
}

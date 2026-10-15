import { AuiConfig, Tools } from '@assistant-ui/react';
import { useMemo } from 'react';
import { useBrowserExtensions } from './extension-loading';
export function useExtensionConfig(userId: string) {
  const { capabilities, loaded } = useBrowserExtensions(userId);
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

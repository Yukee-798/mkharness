import type { Toolkit } from '@assistant-ui/react';
export type BrowserExtension = {
  toolkit: Toolkit;
  activity?: Record<string, 'visible' | 'hidden'>;
};
export type BrowserLoaders = Record<string, () => Promise<BrowserExtension>>;
export async function loadBrowserExtensions(ids: readonly string[], loaders: BrowserLoaders) {
  const modules: BrowserExtension[] = [],
    unavailable: string[] = [];
  for (const id of new Set(ids)) {
    if (!Object.hasOwn(loaders, id)) {
      unavailable.push(id);
      continue;
    }
    try {
      modules.push(await loaders[id]!());
    } catch {
      unavailable.push(id);
    }
  }
  return { modules, unavailable };
}

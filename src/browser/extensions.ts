import type { Toolkit } from '@assistant-ui/react';
export type BrowserExtension = {
  toolkit: Toolkit;
  activity?: Record<string, 'visible' | 'hidden'>;
};
export type BrowserLoaders = Record<string, () => Promise<BrowserExtension>>;
export async function loadBrowserExtensions(ids: readonly string[], loaders: BrowserLoaders) {
  const modules: BrowserExtension[] = [],
    unavailable: string[] = [];
  const names = new Set<string>();
  for (const id of new Set(ids)) {
    if (!Object.hasOwn(loaders, id)) {
      unavailable.push(id);
      continue;
    }
    try {
      const module = await loaders[id]!();
      const tools = Object.keys(module.toolkit);
      if (
        tools.some((name) => names.has(name)) ||
        Object.entries(module.activity ?? {}).some(
          ([name, visibility]) =>
            !Object.hasOwn(module.toolkit, name) || !['visible', 'hidden'].includes(visibility),
        )
      )
        throw new Error('Invalid or conflicting browser contribution');
      for (const name of tools) names.add(name);
      modules.push(module);
    } catch {
      unavailable.push(id);
    }
  }
  return { modules, unavailable };
}

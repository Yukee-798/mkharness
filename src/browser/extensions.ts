import type { Toolkit, ToolCallMessagePartProps } from '@assistant-ui/react';
import type { ComponentType } from 'react';
export type ExtensionUI = {
  toolTitleMeta?: ComponentType<{ part: ToolCallMessagePartProps }>;
  assistantActions?: ComponentType;
  assistantFooter?: ComponentType;
  composerFooter?: ComponentType;
};
export type ExtensionDecoration = ExtensionUI & { id: string };
export type BrowserExtension = {
  toolkit?: Toolkit;
  activity?: Record<string, 'visible' | 'hidden'>;
  ui?: ExtensionUI;
};
export type BrowserLoaders = Record<string, () => Promise<BrowserExtension>>;
export async function loadBrowserExtensions(ids: readonly string[], loaders: BrowserLoaders) {
  const modules: (BrowserExtension & { id: string })[] = [],
    unavailable: string[] = [];
  const names = new Set<string>();
  const unique = [...new Set(ids)];
  // Fetch independently; validate in declaration order so conflict resolution
  // never depends on which network request happens to finish first.
  const loaded = await Promise.allSettled(
    unique.map(async (id) => {
      if (!Object.hasOwn(loaders, id)) throw new Error('Unknown browser extension');
      return loaders[id]!();
    }),
  );
  for (const [index, id] of unique.entries()) {
    const result = loaded[index]!;
    if (result.status === 'rejected') {
      unavailable.push(id);
      continue;
    }
    try {
      const module = result.value;
      const tools = Object.keys(module.toolkit ?? {});
      if (
        tools.some((name) => names.has(name)) ||
        Object.entries(module.activity ?? {}).some(
          ([name, visibility]) =>
            !Object.hasOwn(module.toolkit ?? {}, name) ||
            !['visible', 'hidden'].includes(visibility),
        )
      )
        throw new Error('Invalid or conflicting browser contribution');
      for (const name of tools) names.add(name);
      modules.push({ ...module, id });
    } catch {
      unavailable.push(id);
    }
  }
  return { modules, unavailable };
}

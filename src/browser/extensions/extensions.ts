import type { Toolkit, ToolCallMessagePartProps } from '@assistant-ui/react';
import type { ComponentType } from 'react';
import type { ExtensionState } from '../../shared/extension-state';
import type { WorkbenchPanelDefinition } from '../workbench/panels';
export type ExtensionUI = {
  toolDisplayName?: (name: string, state?: ExtensionState) => string | undefined;
  toolFooter?: ComponentType<{ part: ToolCallMessagePartProps }>;
  toolTitleMeta?: ComponentType<{ part: ToolCallMessagePartProps }>;
  assistantActions?: ComponentType;
  assistantFooter?: ComponentType;
  composerFooter?: ComponentType;
};
export type ExtensionDecoration = ExtensionUI & { id: string };
export type BrowserExtension = {
  pack?: { id: string; version: string };
  layouts?: Readonly<Record<string, import('../workspace/layout').LayoutAdapter>>;
  toolkit?: Toolkit;
  activity?: Record<string, 'visible' | 'hidden'>;
  ui?: ExtensionUI;
  panels?: Readonly<Record<string, WorkbenchPanelDefinition>>;
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
        Object.values(module.layouts ?? {}).some(
          (layout) =>
            !['left', 'right'].includes(layout.conversationSide) ||
            !Number.isFinite(layout.primaryShare) ||
            layout.primaryShare < 0 ||
            layout.primaryShare > 100,
        ) ||
        Object.entries(module.panels ?? {}).some(
          ([name, panel]) =>
            !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(name) ||
            !panel ||
            !['conversation', 'workspace'].includes(panel.scope) ||
            typeof panel.parse !== 'function' ||
            typeof panel.key !== 'function' ||
            typeof panel.title !== 'function' ||
            typeof panel.Content !== 'function' ||
            (panel.restore !== undefined && typeof panel.restore !== 'function'),
        ) ||
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

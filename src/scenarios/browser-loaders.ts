import configuration from '../../scenarios.config';
import type { BrowserLoaders } from '../browser/extensions/extensions';
/** Package browser entry may contribute message UI, tools, panels and layouts. */
export const packageBrowserEntries: BrowserLoaders = {
  reports: () => import('./reports/browser'),
  canvas: () => import('./canvas/browser'),
};
for (const pack of configuration.packs)
  if (!packageBrowserEntries[pack.id]) throw new Error(`Missing package browser entry: ${pack.id}`);
export const sceneBrowserLoaders: BrowserLoaders = Object.fromEntries(
  configuration.packs.map((pack) => [
    `scenario.${pack.id}`,
    async () => {
      const module = await packageBrowserEntries[pack.id]();
      if (module.pack?.id !== pack.id || module.pack.version !== pack.version)
        throw new Error(`Browser pack version mismatch: ${pack.id}`);
      return module;
    },
  ]),
);
export const sceneBrowserIds = Object.keys(sceneBrowserLoaders);

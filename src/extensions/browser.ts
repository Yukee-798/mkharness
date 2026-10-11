import type { BrowserLoaders } from '../browser/extensions';
/** Static reviewed imports; server IDs cannot supply executable URLs. */
export const browserLoaders: BrowserLoaders = {
  web: () => import('./web/browser'),
  openui: () => import('./openui/browser'),
  example: () => import('./example/browser'),
  'skills-example': async () => ({ toolkit: {} }),
};

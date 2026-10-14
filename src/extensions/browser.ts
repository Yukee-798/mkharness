import type { BrowserLoaders } from '../browser/extensions';
/** Static reviewed imports; server IDs cannot supply executable URLs. */
export const browserLoaders: BrowserLoaders = {
  timing: () => import('./timing/browser'),
  web: () => import('./web/browser'),
  openui: () => import('./openui/browser'),
  reply: () => import('./reply/browser'),
  example: () => import('./example/browser'),
  'skills-example': async () => ({ toolkit: {} }),
};

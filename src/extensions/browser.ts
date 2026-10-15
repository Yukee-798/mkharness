import type { BrowserLoaders } from '../browser/extensions';
/** Static reviewed imports; server IDs cannot supply executable URLs. */
export const browserLoaders: BrowserLoaders = {
  skills: () => import('./skills/browser'),
  mcp: () => import('./mcp/browser'),
  timing: () => import('./timing/browser'),
  web: () => import('./web/browser'),
  openui: () => import('./openui/browser'),
  reply: () => import('./reply/browser'),
  'async-example': () => import('./async-example/browser'),
  example: () => import('./example/browser'),
  'skills-example': async () => ({ toolkit: {} }),
};

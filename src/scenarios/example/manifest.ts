import type { ScenarioManifest } from '../registry';
/** Optional trusted package: add to scenarios.config.ts and both activation lists. */
export const exampleManifest = {
  id: 'example-workspace',
  version: '1.0.0',
  dependencies: [],
  views: [],
  layouts: [],
} satisfies ScenarioManifest;

import type { ScenarioManifest } from '../registry';
export const canvasManifest = {
  id: 'canvas',
  version: '1.0.0',
  dependencies: [],
  views: ['canvas'],
  layouts: ['studio'],
} as const satisfies ScenarioManifest;

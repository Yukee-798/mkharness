import type { ScenarioManifest } from '../registry';
export const reportsManifest = {
  id: 'reports',
  version: '1.0.0',
  dependencies: [],
  views: ['reports'],
  layouts: ['chat', 'split'],
} as const satisfies ScenarioManifest;

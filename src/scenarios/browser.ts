import type { ComponentType } from 'react';
import configuration from '../../scenarios.config';
import { validateScenarios } from './registry';
/** Trusted local/npm imports. Lazy view modules keep React Flow outside plain chat. */
export const packViews: Record<string, () => Promise<{ default: ComponentType }>> = {
  canvas: () => import('./canvas/View'),
  reports: () => import('./reports/View'),
};
validateScenarios(
  configuration,
  configuration.packs.map((p) => p.id),
  Object.keys(packViews),
);
export const browserScenes = Object.fromEntries(
  configuration.scenes.map((scene) => [scene.id, packViews[scene.view]]),
);

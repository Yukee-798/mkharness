import { canvasManifest } from './src/scenarios/canvas/manifest';
import { reportsManifest } from './src/scenarios/reports/manifest';
import type { ScenarioConfiguration } from './src/scenarios/registry';

/** Trusted packages are imported at build time; no executable URLs from clients. */
export default {
  packs: [reportsManifest, canvasManifest],
  scenes: [
    {
      id: 'agent',
      title: 'Agent',
      packs: ['reports'],
      layout: 'chat',
      view: 'reports',
      activationObjectTypes: ['report'],
    },
    { id: 'canvas', title: '创作画布', packs: ['canvas'], layout: 'studio', view: 'canvas' },
  ],
} satisfies ScenarioConfiguration;

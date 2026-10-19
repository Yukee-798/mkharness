import type { Json } from '../shared/json';
import { jsonText } from '../shared/json';
export type LayoutId = 'chat' | 'split' | 'studio' | (string & {});
export type ScenarioManifest = {
  id: string;
  version: string;
  config?: { readonly [key: string]: Json };
  dependencies: readonly string[];
  views: readonly string[];
  layouts: readonly LayoutId[];
};
export type ScenarioDefinition = {
  id: string;
  title: string;
  packs: readonly string[];
  layout: LayoutId;
  view: string;
  activationObjectTypes?: readonly string[];
};
export type ScenarioConfiguration = {
  packs: readonly ScenarioManifest[];
  scenes: readonly ScenarioDefinition[];
};

export function validateScenarios(
  config: ScenarioConfiguration,
  serverIds: readonly string[],
  browserViews: readonly string[],
) {
  const packs = new Map<string, ScenarioManifest>();
  for (const pack of config.packs) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(pack.id) ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(pack.version) ||
      packs.has(pack.id)
    )
      throw new Error(`Invalid or duplicate scene pack: ${pack.id}`);
    if (!serverIds.includes(pack.id)) throw new Error(`Missing server contribution: ${pack.id}`);
    if (pack.views.some((view) => !browserViews.includes(view)))
      throw new Error(`Missing browser view: ${pack.id}`);
    if (pack.config) jsonText(pack.config);
    packs.set(pack.id, pack);
  }
  const visit = (id: string, stack: string[]) => {
    const pack = packs.get(id);
    if (!pack) throw new Error(`Missing pack dependency: ${id}`);
    if (stack.includes(id))
      throw new Error(`Cyclic pack dependency: ${[...stack, id].join(' -> ')}`);
    for (const dep of pack.dependencies) visit(dep, [...stack, id]);
  };
  for (const pack of packs.values()) visit(pack.id, []);
  const scenes = new Set<string>();
  for (const scene of config.scenes) {
    if (scenes.has(scene.id)) throw new Error(`Duplicate scene: ${scene.id}`);
    scenes.add(scene.id);
    for (const id of scene.packs) visit(id, []);
    if (
      !browserViews.includes(scene.view) ||
      !scene.packs.some((id) => packs.get(id)?.views.includes(scene.view))
    )
      throw new Error(`Unknown scene view: ${scene.view}`);
    if (!scene.packs.some((id) => packs.get(id)?.layouts.includes(scene.layout)))
      throw new Error(`Unsupported scene layout: ${scene.layout}`);
  }
  return config;
}

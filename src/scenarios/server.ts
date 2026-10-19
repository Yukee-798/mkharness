import configuration from '../../scenarios.config';
import { validateScenarios, type ScenarioConfiguration } from './registry';
import { canvasServer } from './canvas/server';
import { reportsServer } from './reports/server';
import type {
  WorkspaceServerPack,
  WorkspaceHandler,
  WorkspaceQuery,
} from '../server/workspace/types';
/** Add trusted local/npm imports here together with their browser and manifest entries. */
export const serverPacks: readonly WorkspaceServerPack[] = [canvasServer, reportsServer];
export function createScenarioRegistry(
  config: ScenarioConfiguration,
  packs: readonly WorkspaceServerPack[],
  browserViews: readonly string[],
) {
  for (const manifest of config.packs) {
    const server = packs.find((pack) => pack.id === manifest.id);
    if (server && server.version !== manifest.version)
      throw new Error(`Server pack version mismatch: ${manifest.id}`);
  }
  const scenarios = validateScenarios(
    config,
    packs.map((p) => p.id),
    browserViews,
  );
  const resolved = new Map<
    string,
    {
      commands: Record<string, WorkspaceHandler>;
      queries: Record<string, WorkspaceQuery>;
      packs: readonly WorkspaceServerPack[];
    }
  >();
  for (const scene of scenarios.scenes) {
    const ids = new Set<string>();
    const collect = (id: string) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const dep of scenarios.packs.find((p) => p.id === id)!.dependencies) collect(dep);
    };
    scene.packs.forEach(collect);
    const commands: Record<string, WorkspaceHandler> = {},
      queries: Record<string, WorkspaceQuery> = {};
    for (const pack of packs.filter((p) => ids.has(p.id))) {
      for (const [name, handler] of Object.entries(pack.commands)) {
        if (commands[name] || ['workspace.undo', 'workspace.redo'].includes(name))
          throw new Error(`Duplicate or reserved workspace command: ${name}`);
        commands[name] = handler;
      }
      for (const [name, query] of Object.entries(pack.queries ?? {})) {
        if (queries[name] || ['snapshot', 'object'].includes(name))
          throw new Error(`Duplicate or reserved workspace query: ${name}`);
        queries[name] = query;
      }
    }
    resolved.set(scene.id, { commands, queries, packs: packs.filter((p) => ids.has(p.id)) });
  }
  return {
    scenarios,
    scene(kind: string) {
      const value = resolved.get(kind);
      if (!value) throw new Error(`Unknown scenario definition: ${kind}`);
      return value;
    },
  };
}
export const scenarioRegistry = createScenarioRegistry(
  configuration,
  serverPacks,
  configuration.packs.flatMap((p) => [...p.views]),
);
export const scenarios = scenarioRegistry.scenarios;
export const sceneCommands = (kind: string) => scenarioRegistry.scene(kind).commands;
export const sceneQueries = (kind: string) => scenarioRegistry.scene(kind).queries;

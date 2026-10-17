import { fileURLToPath } from 'node:url';
import type { EnvironmentModuleNode, Plugin } from 'vite';

/** DO module replacement leaves old async runtimes alive in the Vite runner.
 * Restart workerd for changes to its dependency tree, retaining durable storage.
 * Client-only changes continue to use normal React HMR.
 */
export function durableReload(
  entry = fileURLToPath(new URL('../src/server/chat/session-object.ts', import.meta.url)),
): Plugin {
  return {
    name: 'durable-runtime-reload',
    apply: 'serve',
    hotUpdate: {
      order: 'pre',
      handler({ file, modules, server }) {
        if (this.environment.name === 'client') return;
        const changed = new Set(modules);
        const visited = new Set<EnvironmentModuleNode>();
        const pending = [...(this.environment.moduleGraph.getModulesByFile(entry) ?? [])];
        let affected = file === entry;
        while (pending.length && !affected) {
          const module = pending.pop()!;
          if (visited.has(module)) continue;
          visited.add(module);
          affected = changed.has(module);
          pending.push(...module.importedModules);
        }
        if (!affected) return;
        void server.restart();
        return [];
      },
    },
  };
}

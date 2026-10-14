import { createServer, isRunnableDevEnvironment, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/** Derive server metadata from the browser's native library at build time.
 * Workers only receive JSON: React components and random library IDs never execute there. */
export function openuiServerCatalog(prepareOnStart: () => boolean = () => true): Plugin {
  const id = 'virtual:mkharness-openui-catalog',
    resolved = '\0' + id;
  const catalog = fileURLToPath(new URL('../src/extensions/openui/catalog.tsx', import.meta.url));
  let generated: Promise<string> | undefined;
  const generate = async () => {
    const loader = await createServer({
      configFile: false,
      root: fileURLToPath(new URL('..', import.meta.url)),
      appType: 'custom',
      cacheDir: '.wrangler/openui-catalog-cache',
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true },
      plugins: [react()],
    });
    try {
      const environment = loader.environments.ssr;
      if (!isRunnableDevEnvironment(environment))
        throw new Error('OpenUI catalog requires a Node build environment');
      const { library } = await environment.runner.import(catalog);
      return `export const schema = ${JSON.stringify(library.toJSONSchema())};\nexport const spec = ${JSON.stringify(library.toSpec())};`;
    } finally {
      await loader.close();
    }
  };
  return {
    name: 'openui-server-catalog',
    async configureServer() {
      // Finish dev-only metadata preparation before listening. load() shares the
      // same promise, so the first Agent request never starts a second generator.
      if (prepareOnStart()) await (generated ??= generate());
    },
    resolveId(source) {
      if (source === id) return resolved;
    },
    load(source) {
      if (source !== resolved) return;
      this.addWatchFile(catalog);
      return (generated ??= generate());
    },
    hotUpdate(context) {
      if (
        !context.file.startsWith(
          fileURLToPath(new URL('../src/extensions/openui/', import.meta.url)),
        )
      )
        return;
      generated = undefined;
      const module = this.environment.moduleGraph.getModuleById(resolved);
      if (module) {
        this.environment.moduleGraph.invalidateModule(module);
        return [...context.modules, module];
      }
    },
  };
}

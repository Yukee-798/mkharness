import { createServer, isRunnableDevEnvironment, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

/** Derive server metadata from the browser's native library at build time.
 * Workers only receive JSON: React components and random library IDs never execute there. */
export function openuiBuild({ enabled = true, inspect = false } = {}): Plugin {
  const id = 'virtual:mkharness-openui-catalog',
    resolved = '\0' + id;
  const catalog = fileURLToPath(new URL('./catalog.tsx', import.meta.url));
  let generated: Promise<string> | undefined;
  const generate = async () => {
    const loader = await createServer({
      configFile: false,
      root: fileURLToPath(new URL('../../..', import.meta.url)),
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
  const directory = fileURLToPath(new URL('./', import.meta.url));
  const disabled = '\0mkharness:disabled-openui';
  return {
    name: 'openui-extension-build',
    enforce: 'pre',
    config() {
      return {
        resolve: {
          alias: {
            // A .wasm specifier lets Cloudflare's native-module resolver own this import.
            ...(enabled
              ? {
                  '#openui-quickjs.wasm': createRequire(import.meta.url).resolve(
                    '@jitl/quickjs-wasmfile-release-sync/wasm',
                  ),
                }
              : {}),
            ...(inspect && enabled
              ? {}
              : { '@openuidev/devtools': resolve(directory, 'devtools.ts') }),
          },
        },
      };
    },
    async configureServer() {
      // Finish dev-only metadata preparation before listening. load() shares the
      // same promise, so the first Agent request never starts a second generator.
      if (enabled) await (generated ??= generate());
    },
    resolveId(source, importer) {
      // The disabled extension has no transitive browser/server import graph.
      // This removes its React library, compute Worker and QuickJS WASM from builds too.
      if (!enabled && importer && (source.startsWith('.') || source.startsWith('/'))) {
        const target = resolve(dirname(importer.split('?')[0]!), source).replace(
          /\.(tsx?|jsx?)$/,
          '',
        );
        if (target === resolve(directory, 'server') || target === resolve(directory, 'browser'))
          return disabled;
      }
      if (source === id) return resolved;
    },
    load(source) {
      if (source === disabled)
        return 'export const toolkit = {}; export function openuiContribution() { throw new Error("OpenUI is disabled in extensions.config.ts"); }';
      if (source !== resolved) return;
      this.addWatchFile(catalog);
      return (generated ??= generate());
    },
    hotUpdate(context) {
      if (!context.file.startsWith(fileURLToPath(new URL('./', import.meta.url)))) return;
      generated = undefined;
      const module = this.environment.moduleGraph.getModuleById(resolved);
      if (module) {
        this.environment.moduleGraph.invalidateModule(module);
        return [...context.modules, module];
      }
    },
  };
}

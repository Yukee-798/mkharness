import { openuiServerCatalog } from './config/openui-catalog';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { durableReload } from './config/durable-reload';
import { unstable_readConfig, unstable_getVarsForDev } from 'wrangler';
// Miniflare's local trace store has no retention policy. Keep console diagnostics,
// but only collect persistent spans/logs when explicitly requested for debugging.
process.env.X_LOCAL_OBSERVABILITY ??= 'false';
const browserTests = process.env.AGENT_E2E_FIXTURES === '1';
const configPath = browserTests ? 'tests/e2e/worker.jsonc' : undefined;
export default defineConfig({
  // Exercise bundled assets in E2E without mixing test fixtures into deploy output.
  ...(browserTests ? { build: { outDir: '.wrangler/e2e-build' } } : {}),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      ...(process.env.OPENUI_INSPECT === '1'
        ? {}
        : {
            '@openuidev/devtools': fileURLToPath(
              new URL('./src/extensions/openui/devtools.ts', import.meta.url),
            ),
          }),
    },
  },
  plugins: [
    openuiServerCatalog(() => {
      // Use Wrangler's own precedence for config/.dev.vars; disabled OpenUI
      // must not evaluate the browser catalog during development startup.
      const env = process.env.CLOUDFLARE_ENV;
      const config = unstable_readConfig({ config: configPath, env }, { hideWarnings: true });
      const vars = unstable_getVarsForDev(
        config.configPath,
        undefined,
        config.vars,
        env,
        true,
        config.secrets,
      );
      return vars.ENABLE_GENERATIVE_UI?.value !== '0';
    }),
    durableReload(),
    {
      name: 'browser-test-fixtures',
      apply: 'serve',
      configureServer(server) {
        if (process.env.AGENT_E2E_FIXTURES !== '1') return;
        server.middlewares.use(async (req, res, next) => {
          const path = req.url?.split('?')[0];
          if (!path || !/^\/tests\/browser\/(compute|panel|chat)\.html$/.test(path)) {
            return next();
          }
          const source = await readFile(new URL('.' + path, import.meta.url), 'utf8');
          const html = await server.transformIndexHtml(path, source);
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
        });
      },
    },
    cloudflare({
      configPath,
      viteEnvironment: { name: 'ssr' },
      persistState: process.env.AGENT_E2E_FIXTURES === '1' ? { path: '.wrangler/e2e' } : true,
    }),
    tailwindcss(),
    tanstackStart({ server: { entry: './server.ts' } }),
    react(),
  ],
  worker: { format: 'es' },
});

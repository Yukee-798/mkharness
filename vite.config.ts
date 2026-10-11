import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { durableReload } from './config/durable-reload';
// Miniflare's local trace store has no retention policy. Keep console diagnostics,
// but only collect persistent spans/logs when explicitly requested for debugging.
process.env.X_LOCAL_OBSERVABILITY ??= 'false';
export default defineConfig({
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
      viteEnvironment: { name: 'ssr' },
      persistState: process.env.AGENT_E2E_FIXTURES === '1' ? { path: '.wrangler/e2e' } : true,
    }),
    tailwindcss(),
    tanstackStart({ server: { entry: './server.ts' } }),
    react(),
  ],
  worker: { format: 'es' },
});

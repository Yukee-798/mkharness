import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

// Start owns a single client entry. Bundle the component harnesses separately,
// adding only test assets to the isolated E2E output, without changing its manifest.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../src', import.meta.url)),
      '@openuidev/devtools': fileURLToPath(
        new URL('../../src/extensions/openui/devtools.ts', import.meta.url),
      ),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'unresponsive-worker-fixture',
      async generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'tests/browser/stalled.worker.js',
          source: await readFile(new URL('./stalled.worker.ts', import.meta.url), 'utf8'),
        });
      },
    },
  ],
  build: {
    outDir: '.wrangler/e2e-build/client',
    emptyOutDir: false,
    assetsDir: 'fixture-assets',
    rolldownOptions: {
      input: Object.fromEntries(
        ['compute', 'panel', 'chat'].map((name) => [
          name,
          fileURLToPath(new URL(`./${name}.html`, import.meta.url)),
        ]),
      ),
    },
  },
  worker: { format: 'es' },
});

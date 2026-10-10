import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      ...(process.env.OPENUI_INSPECT === '1'
        ? {}
        : {
            '@openuidev/devtools': fileURLToPath(
              new URL('./src/browser/openui-devtools.ts', import.meta.url),
            ),
          }),
    },
  },
  plugins: [react(), tailwindcss(), cloudflare()],
  worker: { format: 'es' },
});

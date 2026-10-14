import { openuiServerCatalog } from './config/openui-catalog';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [openuiServerCatalog()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    // Keep the bounded VM stress cases independent of concurrent file compilation / jsdom work.
    fileParallelism: false,
  },
});

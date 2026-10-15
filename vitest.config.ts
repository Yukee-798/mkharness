import { openuiBuild } from './src/extensions/openui/build';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [openuiBuild()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    // Keep the bounded VM stress cases independent of concurrent file compilation / jsdom work.
    fileParallelism: false,
  },
});

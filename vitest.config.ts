import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    // Keep the bounded VM stress cases independent of concurrent file compilation / jsdom work.
    fileParallelism: false,
  },
});

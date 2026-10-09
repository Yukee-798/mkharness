import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './tests/workers/entry.ts',
      miniflare: {
        bindings: {
          MODEL_PROVIDER: 'fixture',
          MODEL_ID: 'fixture',
          BETTER_AUTH_SECRET: 'test-secret-is-long-and-only-in-fixtures-12345',
          GOOGLE_CLIENT_ID: 'fixture',
          GOOGLE_CLIENT_SECRET: 'fixture',
          MODEL_API_KEY: 'fixture',
        },
      },
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    setupFiles: ['./tests/workers/setup.ts'],
    testTimeout: 15000,
    fileParallelism: false,
    include: ['tests/workers/**/*.test.ts'],
  },
});

import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:5174' },
  webServer: {
    command:
      'pnpm exec wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e && pnpm dev --host 127.0.0.1 --port 5174 --strictPort',
    env: {
      BETTER_AUTH_SECRET: 'local-test-only-secret-at-least-32-chars',
      GOOGLE_CLIENT_ID: 'fixture',
      GOOGLE_CLIENT_SECRET: 'fixture',
      MODEL_API_KEY: 'fixture',
      AGENT_E2E_FIXTURES: '1',
    },
    url: 'http://localhost:5174',
    reuseExistingServer: false,
  },
  timeout: 30000,
});

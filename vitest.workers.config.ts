import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './tests/workers/lifecycle-entry.ts',
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2026-10-06',
        compatibilityFlags: ['nodejs_compat'],
        modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'], fallthrough: true }],
        durableObjects: {
          CONVERSATIONS: { className: 'ConversationAgent', useSQLite: true },
          LIFECYCLE_PROBES: { className: 'LifecycleProbe', useSQLite: true },
          BYOK_PROBES: { className: 'BYOKProbe', useSQLite: true },
          BINDING_PROBES: { className: 'BindingProbe', useSQLite: true },
        },
        d1Databases: ['DB'],
        bindings: {
          APP_URL: 'http://localhost:5173',
          AUTH_MODE: 'account',
          MODEL_PROVIDER: 'fixture',
          MODEL_ID: 'fixture',
          BETTER_AUTH_SECRET: 'test-secret-is-long-and-only-in-fixtures-12345',
          GOOGLE_CLIENT_ID: 'fixture',
          GOOGLE_CLIENT_SECRET: 'fixture',
          MODEL_API_KEY: 'fixture',
          MCP_FIXTURE_TOKEN: 'mcp-fixture-secret',
          CREDENTIAL_ENCRYPTION_KEY: 'bW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW0=',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./tests/workers/setup.ts'],
    testTimeout: 15000,
    fileParallelism: false,
    include: ['tests/workers/**/*.test.ts'],
  },
});

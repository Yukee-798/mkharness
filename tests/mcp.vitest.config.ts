import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './tests/workers/mcp-entry.ts',
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2026-10-06',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: { MCP_CONNECTIONS: { className: 'McpConnection', useSQLite: true } },
        d1Databases: ['DB'],
        bindings: {
          APP_URL: 'http://localhost:5173',
          MCP_TEST_SERVERS: JSON.stringify([
            {
              serverId: 'reference',
              endpoint: 'https://mcp.example.test/mcp',
              allowlist: ['lookup', 'status'],
              safeTools: ['status'],
              credential: 'MCP_FIXTURE_TOKEN',
            },
          ]),
          MCP_FIXTURE_TOKEN: 'mcp-fixture-secret',
          CREDENTIAL_ENCRYPTION_KEY: 'bW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW0=',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./tests/workers/setup.ts'],
    testTimeout: 15_000,
    fileParallelism: false,
    include: ['tests/workers/mcp.test.ts', 'tests/workers/mcp-connections.test.ts'],
  },
});

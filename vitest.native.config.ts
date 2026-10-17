import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './tests/native/entry.ts',
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2026-10-06',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        durableObjects: { STORAGE_PROBES: { className: 'StorageProbe', useSQLite: true } },
      },
    }),
  ],
  test: { include: ['tests/native/**/*.test.ts'], testTimeout: 15000, fileParallelism: false },
});

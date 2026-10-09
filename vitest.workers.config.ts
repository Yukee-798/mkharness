import {defineConfig} from 'vitest/config';
import {cloudflareTest} from '@cloudflare/vitest-plugin';
export default defineConfig({plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'}})],test:{include:['tests/workers/**/*.test.ts']}});

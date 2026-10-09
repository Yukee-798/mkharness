import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/e2e',use:{baseURL:'http://localhost:5173'},webServer:{command:'pnpm dev --host 127.0.0.1',url:'http://localhost:5173',reuseExistingServer:!process.env.CI},timeout:30000});

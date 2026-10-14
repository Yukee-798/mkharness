import { test as base, expect } from '@playwright/test';
export { expect };
export type { Locator, Page } from '@playwright/test';
// UI-only mocks use the same deployment capability response as the test server.
// Broad API mocks still pass capability reads through this one explicit fixture.
export const test = base.extend<{ uiLocale: 'en' | 'zh-CN' }>({
  uiLocale: ['zh-CN', { option: true }],
  page: async ({ page, context, uiLocale }, use) => {
    await context.addInitScript((locale) => {
      if (!localStorage.getItem('mkharness.locale'))
        localStorage.setItem('mkharness.locale', locale);
    }, uiLocale);
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/bootstrap') return route.fulfill({ json: { authMode: 'account' } });
      if (path === '/api/settings/models')
        return route.fulfill({
          json: {
            providers: [{ id: 'openai', name: 'OpenAI' }],
            modelCatalog: route.request().frame().url().includes('/tests/browser/')
              ? null
              : {
                  models: [
                    {
                      id: 'fixture',
                      name: 'Fixture',
                      provider: 'fixture',
                      thinkingLevels: ['off', 'low', 'high'],
                    },
                  ],
                  defaultSelection: {
                    provider: 'fixture',
                    modelId: 'fixture',
                    thinkingLevel: 'low',
                  },
                },
            credentialStorageReady: true,
            credentials: ['fixture', 'deepseek', 'openai'].map((provider) => ({
              provider,
              currentId: null,
              configured: false,
              effectiveSource: 'server',
              serverDefaultAllowed: true,
              updatedAt: null,
            })),
          },
        });
      if (path === '/api/capabilities')
        return route.fulfill({ json: { extensionIds: ['web', 'openui', 'example'] } });
      await route.fallback();
    });
    await use(page);
  },
});
export function resource({
  panelRef,
  ui,
  program,
  state = {},
  revision,
}: {
  panelRef: string;
  ui: string;
  program: unknown;
  state?: unknown;
  revision: number;
}) {
  return { ref: panelRef, data: { ui, program }, state, revision };
}

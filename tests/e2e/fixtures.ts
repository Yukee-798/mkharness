import { test as base, expect } from '@playwright/test';
export { expect };
export type { Locator, Page } from '@playwright/test';
// UI-only mocks use the same deployment capability response as the test server.
// Broad API mocks still pass capability reads through this one explicit fixture.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/api/**', async (route) => {
      if (new URL(route.request().url()).pathname === '/api/capabilities')
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

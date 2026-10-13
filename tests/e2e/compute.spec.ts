import { test, expect } from '@playwright/test';
test('cancels an obsolete real Worker and starts a fresh calculation', async ({ page }) => {
  await page.goto('/tests/browser/compute.html');
  await page.waitForFunction(() => typeof (window as any).computeProgram === 'function');
  const result = await page.evaluate(async () => {
    const Original = window.Worker;
    const controller = new AbortController();
    let terminated = 0;
    window.Worker = class extends Original {
      constructor(_url: URL | string, options?: WorkerOptions) {
        super(new URL('/tests/browser/stalled.worker.js', location.origin), options);
        this.addEventListener('message', (event) => {
          if (event.data.type === 'started') controller.abort();
        });
      }
      override terminate() {
        terminated++;
        super.terminate();
      }
    };
    try {
      const cancelled = await (window as any).computeProgram(
        { code: 'export function compute(){return 1}', data: null },
        {},
        controller.signal,
      );
      return { cancelled, terminated };
    } finally {
      window.Worker = Original;
    }
  });
  expect(result).toMatchObject({
    cancelled: { ok: false, error: { kind: 'cancelled' } },
    terminated: 1,
  });
  expect(
    await page.evaluate(() =>
      (window as any).computeProgram(
        { code: 'export function compute(){return 2}', data: null },
        {},
      ),
    ),
  ).toEqual({ ok: true, value: 2 });
});
test('real browser loads WASM, terminates runaway calculation and recovers', async ({ page }) => {
  await page.goto('/tests/browser/compute.html');
  await page.waitForFunction(() => typeof (window as any).computeProgram === 'function');
  const run = async (code: string, inputs: unknown = {}) =>
    page.evaluate(
      async ({ code, inputs }) =>
        (window as any).computeProgram({ code, data: { factor: 2 } }, inputs),
      { code, inputs },
    );
  expect(
    await run(
      'export function compute(i,d){let n=i.start;for(let k=0;k<24;k++)n=n*d.factor+1;return {end:n}}',
      { start: 0 },
    ),
  ).toEqual({ ok: true, value: { end: 16777215 } });
  const failed = await run('export function compute(){while(true){}}');
  expect(failed.ok).toBe(false);
  expect(['timeout', 'budget']).toContain(failed.error.kind);
  expect(await run('export function compute(i){return i}', { value: '' })).toEqual({
    ok: true,
    value: { value: '' },
  });
});
test('terminates an unresponsive real Worker after execution starts', async ({ page }) => {
  await page.goto('/tests/browser/compute.html');
  await page.waitForFunction(() => typeof (window as any).computeProgram === 'function');
  const result = await page.evaluate(async () => {
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(_url: URL | string, options?: WorkerOptions) {
        super(new URL('/tests/browser/stalled.worker.js', location.origin), options);
      }
    };
    try {
      return await (window as any).computeProgram(
        { code: 'export function compute(){return 1}', data: null },
        {},
      );
    } finally {
      window.Worker = Original;
    }
  });
  expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  expect(
    await page.evaluate(() =>
      (window as any).computeProgram(
        { code: 'export function compute(){return 2}', data: null },
        {},
      ),
    ),
  ).toEqual({ ok: true, value: 2 });
});

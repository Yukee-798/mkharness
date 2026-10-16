import { expect, it, vi } from 'vitest';
import { PanelSession } from '../../src/extensions/openui/panel/session';
import type { ComputeResult } from '../../src/extensions/openui/compute/contracts';

it('discards computations from an earlier user epoch and keeps write budgets per binding', async () => {
  let complete!: (value: ComputeResult) => void;
  const report = vi.fn();
  const session = new PanelSession({
    program: { code: '', data: null },
    compute: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
    report,
  });
  const pending = session.run({ value: 1 });
  const rejected = expect(pending).rejects.toThrow('Stale computation');
  session.markUserCommit();
  complete({ ok: true, value: { next: 2 } });
  await rejected;
  const writes = new PanelSession({ report });
  const first = {},
    second = {};
  for (let n = 0; n < 3; n++) expect(writes.automaticWrite(first, n, n + 1)).toBe(true);
  expect(writes.automaticWrite(first, 3, 4)).toBe(false);
  expect(writes.automaticWrite(second, 3, 4)).toBe(true);
  writes.markUserCommit();
  expect(writes.automaticWrite(first, 4, 5)).toBe(true);
});
it('only accepts the actual result for the input snapshot that produced it', async () => {
  const session = new PanelSession({
    program: { code: '', data: null },
    compute: async () => ({ ok: true, value: { next: 2 } }),
    report: () => {},
  });
  const inputs = { value: 1 };
  const result = await session.run(inputs);
  expect(session.automaticWrite({}, 1, 2, { inputs, result: { next: 2 } })).toBe(false);
  expect(session.automaticWrite({}, 1, 2, { inputs: { value: 2 }, result })).toBe(false);
  expect(session.automaticWrite({}, 1, 2, { inputs, result })).toBe(true);
  session.markUserCommit();
  // Completed results remain reusable by the renderer's Query cache for equal inputs.
  expect(session.automaticWrite({}, 1, 2, { inputs, result })).toBe(true);
});

import { expect, it } from 'vitest';
import { boundedReporter } from '../../src/server/diagnostics';

it('bounds even alternating errors and reports suppressed counts when the window reopens', () => {
  let time = 0;
  const reports: Array<[string, number]> = [];
  const report = boundedReporter<string>(
    (error, skipped) => reports.push([error, skipped]),
    () => time,
  );
  for (let i = 0; i < 100; i++) report(i % 2 ? 'one' : 'two');
  expect(reports).toHaveLength(5);
  time = 30_000;
  report('recovery');
  expect(reports.at(-1)).toEqual(['recovery', 95]);
  report('next');
  expect(reports.at(-1)).toEqual(['next', 0]);
});

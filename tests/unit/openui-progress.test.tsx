// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Progress } from '../../src/browser/ui/progress';
import { validateProgress } from '../../src/extensions/openui/progress';

afterEach(cleanup);

it('keeps custom maximum, visual fill and accessible values consistent', () => {
  const view = render(<Progress value={80} max={200} aria-label="Goal" />);
  const bar = view.getByRole('progressbar', { name: 'Goal' });
  expect(bar.getAttribute('aria-valuenow')).toBe('80');
  expect(bar.getAttribute('aria-valuemax')).toBe('200');
  expect((bar.firstElementChild as HTMLElement).style.transform).toBe('translateX(-60%)');
  view.rerender(<Progress value={200} max={200} aria-label="Goal" />);
  expect(bar.getAttribute('data-state')).toBe('complete');
  view.rerender(<Progress value={0} max={200} aria-label="Goal" />);
  expect(bar.getAttribute('aria-valuenow')).toBe('0');
  expect((bar.firstElementChild as HTMLElement).style.transform).toBe('translateX(-100%)');
});

it('represents unknown progress without announcing a made-up value', () => {
  const view = render(<Progress value={null} aria-label="Unknown" />);
  const bar = view.getByRole('progressbar', { name: 'Unknown' });
  expect(bar.getAttribute('data-state')).toBe('indeterminate');
  expect(bar.hasAttribute('aria-valuenow')).toBe(false);
});

it.each([
  { value: -1 },
  { value: 101 },
  { value: NaN },
  { value: Infinity },
  { value: 1, max: 0 },
  { value: 1, max: Infinity },
])('rejects invalid progress instead of displaying a misleading bar: %j', (props) => {
  expect(() => validateProgress(props)).toThrow('Progress');
});

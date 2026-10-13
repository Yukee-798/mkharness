import { expect, it } from 'vitest';
import { inputState } from '../../src/extensions/openui/state';

it('encodes absent native field metadata without changing represented answers or reactive bindings', () => {
  const raw = {
    $choice: 'A',
    form: { choice: { value: 'B', componentType: undefined }, empty: undefined },
    values: [false, 0, '', null],
  };
  expect(inputState(raw)).toEqual({
    $choice: 'A',
    form: { choice: { value: 'B' } },
    values: [false, 0, '', null],
  });
  expect(Object.hasOwn(raw.form.choice, 'componentType')).toBe(true);
});

it.each([NaN, Infinity, -Infinity, 1n, () => {}, new Date(), [undefined], new Array(1)])(
  'rejects invalid represented values instead of silently coercing them: %s',
  (value) => {
    expect(() => inputState({ field: value })).toThrow();
  },
);

it('rejects cycles and accessors without executing them, while allowing shared JSON values', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => inputState(cycle)).toThrow();
  let accessed = false;
  const accessor = Object.defineProperty({}, 'value', {
    get() {
      accessed = true;
      return 1;
    },
  });
  expect(() => inputState({ accessor })).toThrow();
  expect(accessed).toBe(false);
  const shared = { value: 1 };
  expect(inputState({ a: shared, b: shared })).toEqual({ a: { value: 1 }, b: { value: 1 } });
});

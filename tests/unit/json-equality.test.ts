import { it, expect } from 'vitest';
import { jsonEqual, canonicalJson } from '../../src/shared/compute';
it('compares finite JSON objects independently of key order, preserving arrays and types', () => {
  expect(jsonEqual({ a: 1, b: [{ x: 2, y: 3 }] }, { b: [{ y: 3, x: 2 }], a: 1 })).toBe(true);
  expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  expect(jsonEqual('1', 1)).toBe(false);
  expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  expect(() => canonicalJson({ x: NaN })).toThrow();
});

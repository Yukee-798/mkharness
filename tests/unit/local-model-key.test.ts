// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  readModelKey,
  rememberModelKey,
  retainModelKeys,
} from '../../src/browser/models/local-model-key';
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it('restores only the same identity, provider and immutable credential version', () => {
  rememberModelKey('a', 'deepseek', { currentId: 'v1', apiKey: 'canary-local-only' });
  expect(readModelKey('b', 'deepseek', 'v1')).toBeUndefined();
  expect(readModelKey('a', 'openai', 'v1')).toBeUndefined();
  expect(readModelKey('a', 'deepseek', 'v1')?.apiKey).toBe('canary-local-only');
  expect(readModelKey('a', 'deepseek', 'v2')).toBeUndefined();
  expect(localStorage.length).toBe(0);
});
it('clears other accounts on switch and all remembered keys on sign-out without clearing unrelated storage', () => {
  localStorage.setItem('sidebar', 'collapsed');
  for (const owner of ['a', 'b'])
    rememberModelKey(owner, 'deepseek', { currentId: 'v1', apiKey: 'canary' });
  retainModelKeys('b');
  expect(localStorage.length).toBe(2);
  retainModelKeys();
  expect(Object.keys(localStorage)).toEqual(['sidebar']);
});
it('handles unavailable storage without failing server authentication', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  expect(rememberModelKey('a', 'deepseek', { currentId: 'v1', apiKey: 'canary' })).toBe(false);
  expect(readModelKey('a', 'deepseek', 'v1')).toBeUndefined();
});

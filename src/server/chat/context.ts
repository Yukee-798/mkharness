import type { Harness } from '@earendil-works/pi-durable';

export const BG: Parameters<Harness['close']>[0] = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => '[Application background]',
});

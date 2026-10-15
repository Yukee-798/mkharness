import { afterEach, expect, it, vi } from 'vitest';
import { computeProgram } from '../../src/extensions/openui/compute/browser';

class CalculationWorker {
  static instances: CalculationWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    CalculationWorker.instances.push(this);
  }
}
const program = { code: 'export function compute(){return 1}', data: null };
function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', CalculationWorker);
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  CalculationWorker.instances.length = 0;
});
it('does not allocate a Worker for an already cancelled calculation', async () => {
  setup();
  const controller = new AbortController();
  controller.abort();
  const result = computeProgram(program, {}, controller.signal);
  // Let the old implementation settle too, so a regression does not hang this test.
  CalculationWorker.instances[0]?.onmessage?.({
    data: { type: 'result', result: { ok: true, value: 1 } },
  });
  expect(await result).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  expect(CalculationWorker.instances).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels loading work and ignores late messages without leaking timers', async () => {
  setup();
  const controller = new AbortController();
  const result = computeProgram(program, {}, controller.signal);
  const worker = CalculationWorker.instances[0]!;
  controller.abort();
  worker.onmessage?.({ data: { type: 'started' } });
  worker.onmessage?.({ data: { type: 'result', result: { ok: true, value: 1 } } });
  expect(await result).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels execution and removes its abort listener when it settles', async () => {
  setup();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const result = computeProgram(program, {}, controller.signal);
  const worker = CalculationWorker.instances[0]!;
  worker.onmessage?.({ data: { type: 'started' } });
  controller.abort();
  worker.onmessage?.({ data: { type: 'result', result: { ok: true, value: 1 } } });
  expect(await result).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('releases a completed computation before a later cancellation', async () => {
  setup();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const result = computeProgram(program, {}, controller.signal);
  const worker = CalculationWorker.instances[0]!;
  worker.onmessage?.({ data: { type: 'started' } });
  worker.onmessage?.({ data: { type: 'result', result: { ok: true, value: 1 } } });
  expect(await result).toEqual({ ok: true, value: 1 });
  controller.abort();
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('settles a Worker construction failure as a bounded calculation error', async () => {
  setup();
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('Unavailable');
      }
    },
  );
  await expect(computeProgram(program, {})).resolves.toMatchObject({
    ok: false,
    error: { kind: 'worker' },
  });
  expect(vi.getTimerCount()).toBe(0);
});
it('cleans up a Worker when posting input fails', async () => {
  setup();
  vi.stubGlobal(
    'Worker',
    class extends CalculationWorker {
      postMessage = vi.fn(() => {
        throw new Error('Cannot clone input');
      });
    },
  );
  await expect(computeProgram(program, {})).resolves.toMatchObject({
    ok: false,
    error: { kind: 'worker' },
  });
  expect(CalculationWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

import { LIMITS, failure, type ComputeResult, type Program } from './contracts';
import type { Json } from '../../../shared/json';
// One worker per invocation: queued/loading work never consumes the execution timeout.
export function computeProgram(
  program: Program,
  inputs: Json,
  signal?: AbortSignal,
): Promise<ComputeResult> {
  if (signal?.aborted) return Promise.resolve(failure('cancelled', 'Calculation cancelled'));
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let loading: ReturnType<typeof setTimeout> | undefined;
    let settled = false,
      started = false;
    const finish = (result: ComputeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(loading);
      signal?.removeEventListener('abort', cancel);
      worker?.terminate();
      resolve(result);
    };
    const cancel = () => finish(failure('cancelled', 'Calculation cancelled'));
    try {
      worker = new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      loading = setTimeout(
        () => finish(failure('loading', 'Calculation engine did not load')),
        15000,
      );
      worker.onmessage = (event) => {
        if (settled) return;
        if (event.data.type === 'started' && !started) {
          started = true;
          clearTimeout(loading);
          timeout = setTimeout(
            () => finish(failure('timeout', 'Calculation exceeded 500ms')),
            LIMITS.timeout,
          );
        }
        if (event.data.type === 'result') finish(event.data.result);
      };
      worker.onerror = () =>
        finish(failure('worker', 'Calculation worker failed to load or execute'));
      worker.postMessage({ program, inputs });
    } catch {
      finish(failure('worker', 'Calculation worker failed to load or execute'));
    }
  });
}

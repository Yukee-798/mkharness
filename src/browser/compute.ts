import { LIMITS, failure, type ComputeResult, type Program, type Json } from '../shared/compute';
// One worker per invocation: queued/loading work never consumes the execution timeout.
export function computeProgram(program: Program, inputs: Json): Promise<ComputeResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const loading = setTimeout(
      () => finish(failure('loading', 'Calculation engine did not load')),
      15000,
    );
    const finish = (result: ComputeResult) => {
      clearTimeout(timeout);
      clearTimeout(loading);
      worker.terminate();
      resolve(result);
    };
    worker.onmessage = (event) => {
      if (event.data.type === 'started') {
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
  });
}

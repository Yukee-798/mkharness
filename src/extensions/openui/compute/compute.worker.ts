import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newVariant, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { createCompute } from './engine';
import type { Program } from './contracts';
import type { Json } from '../../../shared/json';
const modulePromise = newQuickJSWASMModuleFromVariant(
  newVariant(variant, { wasmLocation: wasmUrl }),
);
const compute = createCompute(() => modulePromise);
self.onmessage = async (event: MessageEvent<{ program: Program; inputs: Json }>) => {
  await modulePromise;
  self.postMessage({ type: 'started' });
  self.postMessage({
    type: 'result',
    result: await compute(event.data.program, event.data.inputs),
  });
};

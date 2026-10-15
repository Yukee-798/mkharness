import wasm from '#openui-quickjs.wasm';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newVariant, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { createCompute } from './engine';
let modulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
export const computeProgram = createCompute(
  () =>
    (modulePromise ??= newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule: wasm }))),
);

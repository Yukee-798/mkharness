import wasm from '#quickjs.wasm';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newVariant, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { createCompute } from '../shared/compute';
const modulePromise = newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule: wasm }));
export const computeProgram = createCompute(() => modulePromise);

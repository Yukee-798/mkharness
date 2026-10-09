import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import { newQuickJSWASMModuleFromVariant, Scope } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Program = { code: string; data: Json };
export type ComputeResult = { ok: true; value: Json } | { ok: false; error: { kind: string; message: string } };
export const LIMITS = {code:65536,json:1048576,heap:16777216,interrupts:1024,timeout:500} as const;
const encoder = new TextEncoder();
export function finiteJson(value: unknown): asserts value is Json {
  const seen = new Set<unknown>();
  function visit(v: unknown): void {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || seen.has(v)) throw new Error('Expected finite JSON');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Expected plain JSON');
    seen.add(v);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(v))) {
      if (descriptor.get || descriptor.set) throw new Error('Accessors are not JSON');
      visit(descriptor.value);
    }
    seen.delete(v);
  }
  visit(value);
}
export function jsonText(value: unknown, limit = LIMITS.json): string {
  finiteJson(value);
  const text = JSON.stringify(value);
  if (encoder.encode(text).length > limit) throw new Error('JSON size limit exceeded');
  return text;
}
export const failure = (kind: string, message: string): ComputeResult => ({ok:false,error:{kind,message}});
// Each call owns the runtime and all handles; only the compiled WASM module is cached.
export function createCompute(getModule: () => Promise<QuickJSWASMModule>) {
  return async (program: Program, inputs: Json): Promise<ComputeResult> => {
    let inputText: string;
    try {
      if (typeof program.code !== 'string' || encoder.encode(program.code).length > LIMITS.code) return failure('size','Program exceeds 64 KiB');
      inputText = jsonText([inputs,program.data]);
    } catch (error) { return failure('input',error instanceof Error ? error.message : 'Invalid input'); }
    const module = await getModule();
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(LIMITS.heap);
    runtime.setMaxStackSize(256 * 1024);
    let interrupts = 0;
    runtime.setInterruptHandler(() => ++interrupts > LIMITS.interrupts);
    runtime.setModuleLoader(() => { throw new Error('Imports are unavailable'); });
    const ctx = runtime.newContext();
    try {
      ctx.unwrapResult(ctx.evalCode('globalThis.Date=undefined; Math.random=undefined;')).dispose();
      // Capture serialization intrinsics before executing generated code. Reject values that JSON.stringify would silently change.
      return Scope.withScope(scope => {
      const serialize = scope.manage(ctx.unwrapResult(ctx.evalCode(`(() => {
        const finite=Number.isFinite, entries=Object.getOwnPropertyDescriptors, proto=Object.getPrototypeOf, plain=Object.prototype, array=Array.isArray, stringify=JSON.stringify;
        return value => { const seen=new Set(); function check(v){
          if(v===null || typeof v==='string' || typeof v==='boolean')return;
          if(typeof v==='number' && finite(v))return;
          if(typeof v!=='object'||seen.has(v)||(!array(v)&&proto(v)!==plain&&proto(v)!==null))throw new Error('Output must be finite JSON');
          seen.add(v);for(const key of Object.keys(entries(v))){const d=entries(v)[key];if(d.get||d.set)throw new Error('Accessors are not JSON');check(d.value);}seen.delete(v);
        } check(value); return stringify(value); }
      })()`)));
      const parsed = scope.manage(ctx.unwrapResult(ctx.evalCode(`JSON.parse(${JSON.stringify(inputText)})`)));
      const namespace = scope.manage(ctx.unwrapResult(ctx.evalCode(program.code,'program.mjs',{type:'module'})));
      try {
        const compute = ctx.getProp(namespace,'compute');
        try {
          if (ctx.typeof(compute) !== 'function') return failure('contract','Export a synchronous compute(inputs, data) function');
          const input = ctx.getProp(parsed,0), data = ctx.getProp(parsed,1);
          try {
            const result = ctx.unwrapResult(ctx.callFunction(compute,ctx.undefined,input,data));
            try {
              const serialized = ctx.unwrapResult(ctx.callFunction(serialize,ctx.undefined,result));
              try {
                const text = ctx.getString(serialized);
                if (encoder.encode(text).length > LIMITS.json) return failure('size','Output exceeds 1 MiB');
                return {ok:true,value:JSON.parse(text) as Json};
              } finally { serialized.dispose(); }
            } finally { result.dispose(); }
          } finally { input.dispose(); data.dispose(); }
        } finally { compute.dispose(); }
      } finally { /* Scope releases handles even when module evaluation throws. */ }
      });
    } catch (error) {
      return failure(interrupts > LIMITS.interrupts ? 'budget' : 'program', error instanceof Error ? error.message : 'Program failed');
    } finally { ctx.dispose(); runtime.dispose(); }
  };
}
let modulePromise: Promise<QuickJSWASMModule> | undefined;
export const computeProgram = createCompute(() => modulePromise ??= newQuickJSWASMModuleFromVariant(variant));

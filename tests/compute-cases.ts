import { expect, it } from 'vitest';
import type { Json } from '../src/shared/json';
import type { ComputeResult, Program } from '../src/extensions/openui/compute/contracts';
export function computationContract(compute: (p: Program, i: Json) => Promise<ComputeResult>) {
  it('computes 24 recurrence steps with an independently checked result', async () => {
    const result = await compute(
      {
        code: 'export function compute(i,d){let n=i.start;for(let k=0;k<24;k++)n=n*d.factor+1;return {end:n}}',
        data: { factor: 2 },
      },
      { start: 0 },
    );
    expect(result).toEqual({ ok: true, value: { end: 16777215 } });
  });
  it.each([
    ['missing compute', 'export const other=1;'],
    ['import', 'import x from "host"; export function compute(){return x}'],
    ['non finite', 'export function compute(){return {value:Infinity}}'],
    ['undefined', 'export function compute(){return undefined}'],
    ['function', 'export function compute(){return {fn:()=>1}}'],
    ['cycle', 'export function compute(){const a={};a.self=a;return a}'],
    ['infinite loop', 'export function compute(){while(true){}}'],
    [
      'memory growth',
      'export function compute(){const a=[];while(true)a.push(new Array(10000).fill(42))}',
    ],
  ])(
    'rejects %s with a recoverable error',
    async (_name, code) => {
      const result = await compute({ code, data: null }, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).not.toBe('unimplemented');
      expect(
        await compute({ code: 'export function compute(){return 7}', data: null }, {}),
      ).toEqual({
        ok: true,
        value: 7,
      });
    },
    // Covers WASM allocation/disposal and the recovery invocation too, not just execution.
    // Match the workerd harness budget; production heap, interrupt and Worker deadlines are unchanged.
    15000,
  );
  it('has no host capabilities, environmental clock or randomness', async () => {
    expect(
      await compute(
        {
          code: 'export function compute(){return [typeof fetch,typeof document,typeof process,typeof Date,typeof setTimeout,typeof Math.random]}',
          data: null,
        },
        {},
      ),
    ).toEqual({ ok: true, value: Array(6).fill('undefined') });
  });
  it('isolates each invocation and retains raw input strings', async () => {
    const p = { code: 'let n=0; export function compute(i){return [++n,i.value]}', data: null };
    expect(await compute(p, { value: '' })).toEqual({ ok: true, value: [1, ''] });
    expect(await compute(p, { value: '1.' })).toEqual({ ok: true, value: [1, '1.'] });
  });
  it('bounds code, input and output sizes', async () => {
    for (const [p, i] of [
      [{ code: ' '.repeat(65537), data: null }, {}],
      [{ code: 'export function compute(i){return i}', data: null }, 'x'.repeat(1048577)],
      [{ code: 'export function compute(){return "x".repeat(1048577)}', data: null }, {}],
    ] as [Program, Json][])
      expect((await compute(p, i)).ok).toBe(false);
  });
}

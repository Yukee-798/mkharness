import {test,expect} from '@playwright/test';
test('real browser loads WASM, terminates runaway calculation and recovers',async({page})=>{
  await page.goto('/tests/browser/compute.html');
  await page.waitForFunction(()=>typeof (window as any).computeProgram==='function');
  const run=async(code:string,inputs:unknown={})=>page.evaluate(async({code,inputs})=>(window as any).computeProgram({code,data:{factor:2}},inputs),{code,inputs});
  expect(await run('export function compute(i,d){let n=i.start;for(let k=0;k<24;k++)n=n*d.factor+1;return {end:n}}',{start:0})).toEqual({ok:true,value:{end:16777215}});
  const failed=await run('export function compute(){while(true){}}');
  expect(failed.ok).toBe(false);expect(['timeout','budget']).toContain(failed.error.kind);
  expect(await run('export function compute(i){return i}',{value:''})).toEqual({ok:true,value:{value:''}});
});

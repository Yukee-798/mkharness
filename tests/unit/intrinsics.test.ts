import {it,expect} from 'vitest';import {computeProgram} from '../../src/shared/compute';
it('cannot bypass finite-output checks by changing guest serialization intrinsics',async()=>{
 for(const code of ['Object.keys=()=>[];export function compute(){return {bad:NaN}}','Object.prototype.toJSON=function(){return {forged:true}};export function compute(){return {actual:7}}']){
  const result=await computeProgram({code,data:null},{});
  if(code.includes('NaN'))expect(result.ok).toBe(false);else expect(result).toEqual({ok:true,value:{actual:7}});
 }
});
it('does not use a guest-modified array iterator for output validation',async()=>{expect((await computeProgram({code:'Array.prototype[Symbol.iterator]=function*(){};export function compute(){return {bad:NaN}}',data:null},{})).ok).toBe(false);});

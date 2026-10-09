import {it,expect} from 'vitest';import {validateUI} from '../../src/server/panel-tools';
it('requires computation provenance for program-backed StateSync while preserving simple local writeback',()=>{
 const ui='$x=""\nroot=Stack([StateSync($x,"value",true)])';expect(()=>validateUI(ui,true)).toThrow('provenance');expect(()=>validateUI(ui,false)).not.toThrow();
});

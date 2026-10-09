import {it,expect} from 'vitest';import {validateUI} from '../../src/server/panel-tools';
it('requires computation provenance for program-backed StateSync while preserving simple local writeback',async()=>{
 const ui='$x=""\nroot=Stack([StateSync($x,"value",true)])';await expect(validateUI(ui,true)).rejects.toThrow('provenance');await expect(validateUI(ui,false)).resolves.toBeDefined();
});

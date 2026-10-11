import { it, expect } from 'vitest';
import { validateUI } from '../../src/extensions/openui/tools';
it.each([0, -1, 1])(
  'rejects unsafe discrete slider step/range at publish (step=%s)',
  async (step) => {
    await expect(
      validateUI(`root=Stack([Slider("x","discrete",0,1000000000,${step},[0],"Budget")])`, false),
    ).rejects.toThrow('Slider');
  },
);

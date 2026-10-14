import { expect, it } from 'vitest';
import { validateUI } from '../../src/extensions/openui/tools';

it('publishes sliders and progress together through the shared component schema', async () => {
  await expect(
    validateUI(
      '$amount=[40]\nroot=Stack([Slider("amount","continuous",0,100,1,null,"Amount",null,$amount),Progress($amount[0],"Target",100,true),Progress(null,"Unknown")])',
      false,
    ),
  ).resolves.toHaveProperty('root');
});

it.each(['Progress(101,"Goal")', 'Progress(10,"Goal",0)', 'Progress(-1,"Goal")'])(
  'rejects invalid static progress before publication: %s',
  async (component) => {
    await expect(validateUI(`root=Stack([${component}])`, false)).rejects.toThrow();
  },
);

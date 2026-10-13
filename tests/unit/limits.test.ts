import { it, expect } from 'vitest';
import { checkRunLimits, withRunLimits } from '../../src/server/limits';
import { fixtureModels } from '../fixture-model';
const entries = (rounds: number, failures: number) =>
  [
    { kind: 'pi.user', model: [{ role: 'user' }] },
    ...Array.from({ length: rounds }, () => ({
      kind: 'pi.assistant',
      model: [{ role: 'assistant' }],
    })),
    ...Array.from({ length: failures }, () => ({
      kind: 'pi.toolResult',
      model: [{ role: 'toolResult', toolName: 'prepare_program', isError: true }],
    })),
  ] as any;
it('allows the initial attempt and two repairs, then terminates; caps model rounds at twenty', () => {
  expect(() => checkRunLimits(entries(3, 2))).not.toThrow();
  expect(() => checkRunLimits(entries(3, 3))).not.toThrow();
  expect(() => checkRunLimits(entries(20, 0))).toThrow('20');
  expect(() => checkRunLimits([...entries(20, 3), ...entries(0, 0)])).not.toThrow();
});
it('honors an explicitly configured tool budget without changing the model-round budget', () => {
  expect(() => checkRunLimits(entries(1, 2), 2)).toThrow('2');
  expect(() => checkRunLimits(entries(1, 2), 3)).not.toThrow();
});
it('uses native checkpoint model and reasoning without late replacement by a guard', async () => {
  const models = fixtureModels();
  const selected = models.getModel('fixture', 'fixture-pro')!;
  const wrapped = withRunLimits(
    models,
    async () => [],
    async () => ({
      model: models.getModel('fixture', 'fixture')!,
      thinkingLevel: 'low' as const,
    }),
  );
  const answer = await wrapped
    .streamSimple(selected, { messages: [], systemPrompt: '' }, { reasoning: 'high' })
    .result();
  expect(answer).toMatchObject({ model: 'fixture-pro', thinkingLevel: 'high' });
});

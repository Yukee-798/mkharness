import { it, expect } from 'vitest';
import { checkRunLimits } from '../../src/server/limits';
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

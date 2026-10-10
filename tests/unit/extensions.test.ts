import { it, expect } from 'vitest';
import { validateExtensions } from '../../src/server/extensions';
import { checkRunLimits } from '../../src/server/limits';

it('rejects duplicate extension, tool and task names before native installation', () => {
  expect(() => validateExtensions([{ name: 'x' }, { name: 'x' }])).toThrow('duplicate');
  expect(() =>
    validateExtensions([
      { name: 'a', tools: [{ name: 'read' }] },
      { name: 'b', tools: [{ name: 'read' }] },
    ] as any),
  ).toThrow('duplicate');
  expect(() =>
    validateExtensions([
      { name: 'a', tasks: [{ definition: { name: 'job', version: 1 } }] },
      { name: 'b', tasks: [{ definition: { name: 'job', version: 1 } }] },
    ] as any),
  ).toThrow('duplicate');
});
it('exhausted UI repairs leave ordinary tools and model reasoning available', () => {
  const entries = [
    { kind: 'pi.user' },
    ...Array.from({ length: 3 }, () => ({
      kind: 'pi.toolResult',
      model: [{ role: 'toolResult', toolName: 'present_openui', isError: true }],
    })),
  ] as any;
  expect(() => checkRunLimits(entries)).not.toThrow();
});

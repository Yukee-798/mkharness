// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
const engineImported = vi.hoisted(() => vi.fn());
vi.mock('../../src/extensions/openui/compute/server', () => {
  engineImported();
  return { computeProgram: vi.fn() };
});
import { openuiContribution } from '../../src/extensions/openui/server';
import { validateUI } from '../../src/extensions/openui/tools';
import { toolkit, activity } from '../../src/extensions/openui/browser';
it('assembles the catalog and execution instructions in the same optional native extension', () => {
  const contribution = openuiContribution(async () => []);
  expect(contribution.extension?.sections?.map((section) => section.key)).toEqual(
    expect.arrayContaining(['openui-catalog', 'execution-contract']),
  );
  expect(contribution.extension?.tools?.map((tool) => tool.name)).toEqual([
    'prepare_program',
    'present_openui',
  ]);
});
it('registers generated content with native standalone display and hides internal activity', () => {
  expect(toolkit.present_openui.display).toBe('standalone');
  expect(toolkit.prepare_program.type).toBe('backend');
  expect(activity.prepare_program).toBe('hidden');
});
it('registers tools and validates static content without importing the computation engine', async () => {
  openuiContribution(async () => []);
  await validateUI('root = Stack([TextContent("Ready")])', false);
  expect(engineImported).not.toHaveBeenCalled();
});

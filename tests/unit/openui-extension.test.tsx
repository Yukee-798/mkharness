// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
vi.mock('../../src/server/compute', () => ({ computeProgram: vi.fn() }));
import { openuiContribution } from '../../src/extensions/openui/server';
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

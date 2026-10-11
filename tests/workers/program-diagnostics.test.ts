import { it, expect, vi } from 'vitest';
import { panelTools } from '../../src/extensions/openui/tools';

const prepare = panelTools(async () => []).tools!.find((tool) => tool.name === 'prepare_program')!;
const invoke = (args: unknown, api = {} as any) => prepare.execute(args as any, api, {} as any);
const diagnostic = (result: Awaited<ReturnType<typeof invoke>>) =>
  JSON.parse((result.content![0] as { text: string }).text);

it('returns the failing case and actual score while refusing to publish a mismatched program', async () => {
  // Minimized from the real recipe trace: 40 + 30 + 20 + 15 = 105, not 125.
  const args = {
    code: 'export function compute(i,d){return {recommendations:[{score:i.time+d.diet+i.meal+i.skill}]}}',
    initialInputs: { time: 40, meal: 20, skill: 15 },
    data: { diet: 30 },
    cases: [
      {
        inputs: { time: 40, meal: 20, skill: 15 },
        expected: { recommendations: [{ score: 105 }] },
      },
      {
        inputs: { time: 40, meal: 20, skill: 15 },
        expected: { recommendations: [{ score: 125 }] },
      },
    ],
  };
  const getTask = vi.fn(async () => ({ input: { assistant: 17 } }));
  const api = { getTask, taskId: '1', callId: 'prepare' };
  const failed = await invoke(args, api);
  expect(failed.isError).toBe(true);
  expect(getTask).not.toHaveBeenCalled();
  expect(diagnostic(failed)).toMatchObject({
    code: 'test_case_mismatch',
    caseIndex: 1,
    difference: { path: '/recommendations/0/score', expected: 125, actual: 105 },
    actualOutput: { recommendations: [{ score: 105 }] },
  });
  expect(diagnostic(failed)).not.toHaveProperty('programRef');
  args.cases[1].expected.recommendations[0].score = 105;
  const passed = await invoke(args, api);
  expect(passed.isError).not.toBe(true);
  expect(diagnostic(passed)).toMatchObject({ programRef: '17.prepare' });
});

it('keeps full-output array checks and marks a missing expected element explicitly', async () => {
  const failed = await invoke({
    code: 'export function compute(){return {trace:[1,2]}}',
    initialInputs: {},
    data: null,
    cases: [{ inputs: {}, expected: { trace: [1] } }],
  });
  expect(failed.isError).toBe(true);
  expect(diagnostic(failed).difference).toEqual({
    path: '/trace/1',
    expected: { missing: true },
    actual: 2,
  });
});

it('uses escaped JSON pointers and distinguishes missing values from null', async () => {
  const failed = await invoke({
    code: 'export function compute(){return {"a/b":{}}}',
    initialInputs: {},
    data: null,
    cases: [{ inputs: {}, expected: { 'a/b': { '~score': null } } }],
  });
  expect(diagnostic(failed).difference).toEqual({
    path: '/a~1b/~0score',
    expected: null,
    actual: { missing: true },
  });
});

it('bounds diagnostic output even for large Unicode and escaped strings', async () => {
  const inputs = { text: '😀"\n'.repeat(4000) };
  const failed = await invoke({
    code: 'export function compute(i){return {long:i.text}}',
    initialInputs: inputs,
    data: null,
    cases: [{ inputs, expected: { long: 'wrong' } }],
  });
  expect(failed.isError).toBe(true);
  expect(diagnostic(failed).difference.actual.truncated).toBe(true);
  expect(diagnostic(failed).actualOutput.truncated).toBe(true);
  expect(
    new TextEncoder().encode((failed.content![0] as { text: string }).text).length,
  ).toBeLessThanOrEqual(8192);
});

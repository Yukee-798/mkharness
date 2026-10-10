import { Type } from '@earendil-works/pi-ai';
import {
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type Harness,
} from '@earendil-works/pi-durable';
import { createParser } from '@openuidev/lang-core';
// OpenUI creates random library IDs; initialize within a request, never Worker global scope.
let catalog: Promise<typeof import('../shared/catalog')> | undefined;
const getLibrary = async () => (await (catalog ??= import('../shared/catalog'))).library;
import { toolRef, successfulTool } from '../shared/references';
import { jsonText, jsonEqual, finiteJson, type Program, type Json } from '../shared/compute';
import { computeProgram } from './compute';
import { validateSlider } from '../shared/slider';
function difference(
  expected: Json | undefined,
  actual: Json | undefined,
  path = '',
): { path: string; expected: Json | undefined; actual: Json | undefined } | undefined {
  if (expected === actual) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      const found = difference(expected[i], actual[i], `${path}/${i}`);
      if (found) return found;
    }
    return;
  }
  if (
    expected &&
    actual &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const token = key.replaceAll('~', '~0').replaceAll('/', '~1');
      const found = difference(
        Object.hasOwn(expected, key) ? expected[key] : undefined,
        Object.hasOwn(actual, key) ? actual[key] : undefined,
        `${path}/${token}`,
      );
      if (found) return found;
    }
    return;
  }
  return { path, expected, actual };
}
function preview(value: Json | undefined, limit: number): Json {
  if (value === undefined) return { missing: true };
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= limit
    ? value
    : {
        preview: new TextDecoder().decode(bytes.slice(0, limit)),
        truncated: true,
      };
}
async function ref(api: ToolExecutionApi, context: Parameters<Harness['close']>[0]) {
  const task = await api.getTask(api.taskId, context);
  const input = task?.input;
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.assistant !== 'number'
  )
    throw new Error('Missing Pi calling entry');
  return toolRef(input.assistant, api.callId);
}
export async function validateUI(ui: string, hasProgram: boolean) {
  const library = await getLibrary();
  if (new TextEncoder().encode(ui).length > 262144) throw new Error('UI exceeds 256 KiB');
  const parsed = createParser(library.toJSONSchema()).parse(ui);
  if (
    !parsed.root ||
    parsed.meta.incomplete ||
    parsed.meta.unresolved.length ||
    parsed.meta.errors.length
  )
    throw new Error('Invalid OpenUI: ' + JSON.stringify(parsed.meta));
  if (parsed.mutationStatements.length)
    throw new Error('Mutation is not available; use the continue_analysis host action');
  for (const query of parsed.queryStatements) {
    if (!hasProgram || query.toolAST?.k !== 'Str' || query.toolAST.v !== 'run_program')
      throw new Error('Only the bound run_program Query is available');
  }
  const pending: unknown[] = [parsed.root];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    if (v.typeName === 'Slider' && !v.hasDynamicProps)
      validateSlider(v.props as Record<string, unknown>);
    if (hasProgram && v.typeName === 'StateSync' && !(v.props as Record<string, unknown>)?.computed)
      throw new Error('StateSync requires computation provenance {result,inputs}');
    for (const child of Object.values(v))
      if (child && typeof child === 'object') pending.push(child);
  }
  if (hasProgram && !parsed.queryStatements.length)
    throw new Error('Program-backed UI requires a bound run_program Query for live results');
  return parsed;
}
export function panelTools(
  entries: () => Promise<readonly import('@earendil-works/pi-durable').EntryRecord[]>,
): Extension {
  const prepare = defineTool({
    name: 'prepare_program',
    description:
      'Validate a generated synchronous ES module compute(inputs,data), initial inputs and finite JSON test cases. No imports, host APIs, clock or randomness. Each expected value is the entire output, not a partial subset. Returns programRef and initial result only on success; on mismatch returns the case index, first difference and a bounded actual output for diagnosis.',
    parameters: Type.Object({
      code: Type.String({ maxLength: 65536 }),
      initialInputs: Type.Unknown(),
      data: Type.Unknown(),
      cases: Type.Array(Type.Object({ inputs: Type.Unknown(), expected: Type.Unknown() }), {
        minItems: 1,
        maxItems: 10,
      }),
    }),
    replay: 'safe',
    execute: async (args, api, context) => {
      try {
        finiteJson(args.initialInputs);
        finiteJson(args.data);
        jsonText(args.cases);
        const program: Program = { code: args.code, data: args.data };
        const initial = await computeProgram(program, args.initialInputs);
        if (!initial.ok) throw new Error(initial.error.kind + ': ' + initial.error.message);
        for (const [caseIndex, example] of args.cases.entries()) {
          finiteJson(example.inputs);
          finiteJson(example.expected);
          const computed = await computeProgram(program, example.inputs);
          if (!computed.ok) throw new Error(computed.error.message);
          if (!jsonEqual(computed.value, example.expected)) {
            const mismatch = difference(example.expected, computed.value)!;
            const diagnostic = {
              code: 'test_case_mismatch',
              message:
                'Test case output differs from expected. Check the intended rule before changing code or expected values.',
              caseIndex,
              difference: {
                path: mismatch.path.slice(0, 256),
                expected: preview(mismatch.expected, 512),
                actual: preview(mismatch.actual, 512),
              },
              actualOutput: preview(computed.value, 2048),
            };
            return { isError: true, content: [{ type: 'text', text: jsonText(diagnostic, 8192) }] };
          }
        }
        const programRef = await ref(api, context);
        return {
          content: [{ type: 'text', text: JSON.stringify({ programRef, initial: initial.value }) }],
          details: { ref: programRef, initial: initial.value },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: 'text', text: error instanceof Error ? error.message : 'Invalid program' },
          ],
        };
      }
    },
  });
  const present = defineTool({
    name: 'present_openui',
    description:
      'Publish complete OpenUI Lang using the supplied component catalog. Optional programRef must refer to a committed successful prepare_program in this chat. Use native Query/Set/Reset and the continue_analysis host action.',
    parameters: Type.Object({
      ui: Type.String({ maxLength: 262144 }),
      programRef: Type.Optional(Type.String({ maxLength: 512 })),
    }),
    replay: 'safe',
    execute: async (args, api, context) => {
      try {
        if (args.programRef && !successfulTool(await entries(), args.programRef, 'prepare_program'))
          throw new Error('Program is missing or has not committed successfully');
        await validateUI(args.ui, !!args.programRef);
        const panelRef = await ref(api, context);
        return {
          content: [{ type: 'text', text: JSON.stringify({ panelRef, ready: true }) }],
          details: { ref: panelRef },
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'Invalid UI' }],
        };
      }
    },
  });
  return {
    name: 'panels',
    tools: [prepare, present],
    sections: [
      {
        key: 'ui',
        render: async () =>
          (await getLibrary()).prompt({
            preamble:
              'This catalog describes only the ui argument of present_openui. Keep normal conversation and tool calls outside that string. The ui string must be valid OpenUI Lang, without markdown fences.',
            toolCalls: true,
            bindings: true,
            tools: ['run_program'],
            additionalRules: [
              'Produce ordinary text when no interface helps. For complex computation, first prepare_program and wait for success, then present_openui referencing its programRef. Publishing does not wait for a browser.',
              'A program-backed panel MUST declare a Query("run_program",inputs,fallback). Declare editable inputs as $variables seeded from initialInputs or submitted source.state; bind controls to those variables using the catalog signatures, and include them in Query arguments. Display computed values from the Query result, not copied constants from the initial result. The fallback must match the output shape. Query result variables are ordinary identifiers, not $bindings.',
              'Use native @Set($variable,value) and @Reset($variable,...) on declared bindings. @Reset takes variables, never a Form name or string. Prefer text inputs for numeric parameters when preserving unfinished decimal edits matters. Keep @Each templates inline so their row variable remains in scope.',
              'Only the bound run_program Query is available, and only on panels with a programRef. Its arguments are compute(inputs,data) inputs, with data supplied by the bound program. This is browser-local computation, not an Agent tool or a network request. Mutation and other tools are unavailable. Never invent a tool, business function, script or action handler. Use Action([@ToAssistant("Analyze with these inputs")]) for another agent request; parameter edits calculate locally without model requests.',
              'Show assumptions, units and source descriptions. StateSync(value,next,enabled,{result:theFullQueryResult,inputs:theSameCurrentQueryArguments}) is optional for automatic parameter normalization, not required for derived display values. For StateSync with a program, return an object from compute and pass its complete Query result and current inputs so the host can reject stale or mismatched writeback.',
            ],
          }),
      },
    ],
  };
}

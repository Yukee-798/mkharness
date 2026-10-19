import { Type } from '@earendil-works/pi-ai';
import {
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type Harness,
} from '@earendil-works/pi-durable';
import { createParser } from '@openuidev/lang-core';
import { schema, prompt } from 'virtual:mkharness-openui-catalog';
import { toolRef, successfulTool } from '../../shared/references';
import { jsonText, jsonEqual, finiteJson, type Json } from '../../shared/json';
import type { Program } from './compute/contracts';
import { validateSlider } from './slider';
import { validateProgress } from './progress';
import { validateUIActions } from './contracts';
import { JSON_TOOL_OUTPUT_LIMITS } from '../../server/extensions/tool-output';
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
    input.kind !== 'model' ||
    typeof input.assistant !== 'number'
  )
    throw new Error('Missing Pi calling entry');
  return toolRef(input.assistant, api.callId);
}
export async function validateUI(ui: string, hasProgram: boolean) {
  if (new TextEncoder().encode(ui).length > 262144) throw new Error('UI exceeds 256 KiB');
  const parsed = createParser(schema).parse(ui);
  if (
    !parsed.root ||
    parsed.meta.incomplete ||
    parsed.meta.unresolved.length ||
    parsed.meta.errors.length
  )
    throw new Error('Invalid OpenUI: ' + JSON.stringify(parsed.meta));
  validateUIActions(parsed);
  if (parsed.mutationStatements.length)
    throw new Error(
      'Mutation is not available; use Action([@ToAssistant(...)]) for an agent request',
    );
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
    if (v.typeName === 'Progress' && !v.hasDynamicProps)
      validateProgress(v.props as Record<string, unknown>);
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
  entries: (
    nativeConversationId: number,
  ) => Promise<readonly import('@earendil-works/pi-durable').EntryRecord[]>,
): Extension {
  const prepare = defineTool({
    name: 'prepare_program',
    callers: ['model'],
    // The bounded compute result plus its small, generated reference envelope.
    outputLimits: { ...JSON_TOOL_OUTPUT_LIMITS, maxBytes: JSON_TOOL_OUTPUT_LIMITS.maxBytes + 1024 },
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
        const { computeProgram } = await import('./compute/server');
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
            return { isError: true, output: [{ type: 'text', text: jsonText(diagnostic, 8192) }] };
          }
        }
        const programRef = await ref(api, context);
        return {
          output: [
            {
              type: 'text',
              text: jsonText(
                { programRef, initial: initial.value },
                JSON_TOOL_OUTPUT_LIMITS.maxBytes + 1024,
              ),
            },
          ],
          details: { ref: programRef, initial: initial.value },
        };
      } catch (error) {
        return {
          isError: true,
          output: [
            { type: 'text', text: error instanceof Error ? error.message : 'Invalid program' },
          ],
        };
      }
    },
  });
  const present = defineTool({
    name: 'present_openui',
    callers: ['model'],
    description:
      'Insert one compact inline interactive widget or useful data chart into the current reply. Ordinary text, static tables and the main answer stay in Markdown. Use this only for editable calculations, meaningful choices or visual understanding of data, never as the default answer format. After the widget commits, continue the reply as needed. Supply complete OpenUI Lang; optional programRef must refer to a committed successful prepare_program in this chat. Use native Query/Set/Reset locally and ToAssistant only for explicit user submission.',
    parameters: Type.Object({
      ui: Type.String({ maxLength: 262144 }),
      programRef: Type.Optional(Type.String({ maxLength: 512 })),
    }),
    replay: 'safe',
    execute: async (args, api, context) => {
      try {
        if (
          args.programRef &&
          !successfulTool(
            await entries(Number(api.conversationId)),
            args.programRef,
            'prepare_program',
          )
        )
          throw new Error('Program is missing or has not committed successfully');
        await validateUI(args.ui, !!args.programRef);
        const panelRef = await ref(api, context);
        return {
          output: [{ type: 'text', text: JSON.stringify({ panelRef, ready: true }) }],
          details: { ref: panelRef },
        };
      } catch (error) {
        return {
          isError: true,
          output: [{ type: 'text', text: error instanceof Error ? error.message : 'Invalid UI' }],
        };
      }
    },
  });
  return {
    name: 'panels',
    tools: [prepare, present],
    sections: [
      {
        key: 'openui-catalog',
        render: async () => prompt,
      },
    ],
  };
}

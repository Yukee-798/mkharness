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
      'Display the final answer or clarification questions using complete OpenUI Lang and the supplied component catalog. Call this tool alone after all necessary research and computation. Include useful next steps in the displayed content. Success commits the answer and ends this reply without another model round; validation failure permits repair. Printing UI code in chat does not render it. Static content and forms need no programRef. Optional programRef must refer to a committed successful prepare_program in this chat. Use native Query/Set/Reset and ToAssistant for explicit user submission.',
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
          // Pi commits the result before ending this run and placing queued inputs.
          control: { terminate: true },
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
              'Use present_openui to show visual content as part of your answer. This application renders that content only through an actual tool call; never print OpenUI code in chat, markdown fences, <ui> tags or text that imitates a tool call. This catalog describes only the ui argument of present_openui. Keep normal conversation outside that string. The ui string must be a complete valid OpenUI Lang document, without markdown fences. Generic library examples below describe UI syntax, not the Agent response format.',
            toolCalls: true,
            bindings: true,
            tools: ['run_program'],
            additionalRules: [
              'For explanations longer than a brief answer, recommendations, comparisons, plans and data exploration, show the answer with present_openui instead of a lengthy Markdown answer followed by an offer to create UI. Use native cards, tables, steps, charts and images to organize the answer, with concise supporting text. Static explanations and clarification forms need neither programRef nor Query: use present_openui directly. For complex computation, first prepare_program and wait for success, then present_openui referencing its programRef. This does not wait for a browser.',
              'For clarification, use Form(name,buttons,fields) and FormControl(label,input,hint) with native RadioGroup or Select for single choice, CheckBoxGroup for multiple choice, and Input or TextArea for other details. Form buttons must be Buttons([Button(...)]) rather than a bare Button. Bind answers to declared $variables so edits persist. RadioGroup value is a string; CheckBoxGroup value is an object mapping item names to booleans, not an array. Leave unanswered choices empty unless the user has already supplied them; never set defaultChecked:true merely because an option is recommended. Use rules to mark genuinely required fields. Provide an explicit submit Button with Action([@ToAssistant("Continue using my answers")]); use the user\'s language for its label and message. Local selection and editing must not invoke the Agent; only explicit submission does. The host includes the click-time raw bindings and form state with the new request, so do not hardcode selections into the action message or invent a submit tool. Treat that state as the user\'s answers, then continue without asking the same questions again.',
              'Use appropriate visual components, not just a long paragraph placed in a card. Charts must represent actual data or clearly labeled assumptions, with units and sources. Use Image, ImageBlock, ImageGallery or ImageText only with real image URLs supplied by the user or available in trustworthy source data; include meaningful alt text and source context. There is no image generation or image search tool in this application. When no usable image source is available, use native steps, comparisons, tables or other suitable visuals instead of inventing image URLs.',
              'Use the smallest useful composition: a static explanation usually needs only a few sections, such as a key distinction, a comparison table and an example. Do not expand every answer into a dashboard. For qualitative topics use comparisons or diagrams rather than inventing numeric scores or radar charts, unless the user explicitly requests a hypothetical scoring model. Follow component signatures exactly. Card children must be component nodes, not nested arrays; flatten the nodes or wrap a list in Stack. Avoid trailing commas in component argument lists.',
              'Content with a programRef MUST declare a Query("run_program",inputs,fallback). Declare editable inputs as $variables seeded from initialInputs or submitted source.state; bind controls to those variables using the catalog signatures, and include them in Query arguments. Display computed values from the Query result, not copied constants from the initial result. The fallback must match the output shape. Query result variables are ordinary identifiers, not $bindings.',
              'Use native @Set($variable,value) and @Reset($variable,...) on declared bindings. @Reset takes variables, never a Form name or string. Prefer text inputs for numeric parameters when preserving unfinished decimal edits matters. Keep @Each templates inline so their row variable remains in scope.',
              'Only the bound run_program Query is available, and only in content with a programRef. Its arguments are compute(inputs,data) inputs, with data supplied by the bound program. This is browser-local computation, not an Agent tool or a network request. Mutation and other tools are unavailable. Never invent a tool, business function, script or action handler. Use Action([@ToAssistant("Analyze with these inputs")]) for another agent request; parameter edits calculate locally without model requests.',
              'Show assumptions, units and source descriptions. StateSync(value,next,enabled,{result:theFullQueryResult,inputs:theSameCurrentQueryArguments}) is optional for automatic parameter normalization, not required for derived display values. For StateSync with a program, return an object from compute and pass its complete Query result and current inputs so the host can reject stale or mismatched writeback.',
              'Complete required research and computation before calling present_openui alone as the final tool. The host validates the content and ends the reply only after a successful commit; a failure returns an error for repair. A textual UI description, fenced code or <ui> block is never rendered content in this application.',
              'Each present_openui call supplies a complete replacement document, including repairs. Always include root and every definition it references. Never submit only changed statements or a truncated fragment. When validation fails, fix the reported issue and resubmit the whole document; simplify the composition if necessary rather than adding more sections. An incomplete document with no listed type errors still needs its syntax completed before calling this tool again.',
              'Describe only interactions that the displayed content actually supports. Do not promise blank submission or skipping required fields when form validation prevents it; do not promise automatic defaults, saving or other actions that have not been implemented. Recommendations are suggestions until the user explicitly submits a choice.',
              'Write titles, labels and explanations about the user\'s subject, not the UI mechanism. These components form the answer itself; do not label ordinary content as a generated UI, panel or dashboard (生成式 UI、面板、交互面板), unless a dashboard is what the user actually requested. Put the substantive answer and its necessary assumptions here. Include any necessary next action within this content, referring naturally to the actual chart, comparison or question. A successful tool result ends the reply automatically; no closing model round is needed. Never announce "已发布交互面板" or summarize the layout and contents again.',
            ],
          }),
      },
    ],
  };
}

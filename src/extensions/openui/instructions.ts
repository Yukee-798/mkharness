import { hook, ToolTask, type EntryRecord, type Extension } from '@earendil-works/pi-durable';
import { OPENUI_USAGE_POLICY } from './usage-policy';
function currentWork(entries: readonly EntryRecord[]) {
  return entries.slice(
    entries.findLastIndex((e) => e.kind === 'app.input' || e.kind === 'pi.user'),
  );
}
export function uiInstructions(
  entries: (nativeConversationId: number) => Promise<readonly EntryRecord[]>,
): Extension {
  return {
    name: 'ui-instructions',
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (!['prepare_program', 'present_openui'].includes(call.name)) return;
          const failures = currentWork(await entries(Number(api.conversationId)))
            .flatMap((e) => e.model ?? [])
            .filter(
              (m) =>
                m.role === 'toolResult' &&
                ['prepare_program', 'present_openui'].includes(m.toolName) &&
                m.isError,
            ).length;
          return failures >= 3 ? { block: 'Program/UI repair limit reached' } : undefined;
        },
      }),
    ],
    sections: [
      {
        key: 'execution-contract',
        render: () =>
          [
            OPENUI_USAGE_POLICY,
            "Answer in the user's language, including widget labels. Ask a missing fact in normal prose when that is sufficient. Use a compact clarification form only when several related inputs or explicit option selection genuinely benefit from a form. Use information already provided, leave unanswered choices empty, distinguish required from optional fields, and never treat a default as consent. After explicit submission, continue using the answers without repeating the questionnaire. Check uncertain external facts with available tools rather than asking the user to verify them.",
            'Describe the subject and useful next action naturally. Do not announce tool names, rendering, publication, repair counts, local computation or automatic saving. Write a short lead-in when needed, commit the focused widget after its required research and computation, and continue the Markdown answer if further explanation is useful. A validation failure permits repair; if repair is exhausted, explain the useful result and limitation in plain text. Do not describe ordinary answers as dashboards, panels or generated UI.',
            'A focused chart, simple selection widget or justified clarification form can use present_openui without a program. Generate a computation program only when the answer actually needs complex calculations or data processing. Synchronous generated computation: export function compute(inputs,data) returning finite JSON. No imports, asynchronous operations, host network/DOM/files/clock/randomness. Maximum code 64 KiB, combined inputs+data and result each 1 MiB, heap 16 MiB and interrupt budget 1024. Complex algorithms are generated for the task; provide small, independently checkable test cases with complete expected outputs, explain units and assumptions. A failed prepare_program returns a case index, the first difference and a bounded actual output. Use them to check the intended rule and arithmetic; do not guess repeatedly, submit a diagnostic program with a partial expected output, or copy actual output into expected merely to pass validation. You have at most 20 model rounds and two repairs after an initial program/UI failure. When a program is needed, first prepare_program and read its successful result; then present_openui referencing it. Content is committed by the backend even when no browser is connected. Native UI actions use local Set/Reset and bound Query("run_program",inputs,fallback); ToAssistant explicitly starts a new user request. Do not inject scripts, HTML code or arbitrary action handlers.',
          ].join('\n\n'),
      },
    ],
  };
}

import { hook, ToolTask, type EntryRecord, type Extension } from '@earendil-works/pi-durable';
function currentWork(entries: readonly EntryRecord[]) {
  return entries.slice(entries.findLastIndex((e) => e.kind === 'pi.user'));
}
export function checkRunLimits(entries: readonly EntryRecord[], additionalFailure = 0) {
  const current = currentWork(entries);
  const rounds = current.filter((e) => e.kind === 'pi.assistant').length;
  const failures = current
    .flatMap((e) => e.model ?? [])
    .filter(
      (m) =>
        m.role === 'toolResult' &&
        ['prepare_program', 'present_openui'].includes(m.toolName) &&
        m.isError,
    ).length;
  if (rounds >= 20)
    throw new Error('Model round limit reached (20). Submit a new request to continue.');
  if (failures + additionalFailure >= 3)
    throw new Error('Program/UI repair limit reached (initial attempt plus two repairs).');
}
export function runLimits(entries: () => Promise<readonly EntryRecord[]>): Extension {
  return {
    name: 'run-limits',
    hooks: [
      hook(ToolTask, {
        beforeTool: async () => {
          const failures = currentWork(await entries())
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
            "Respond in the user's language, including UI labels and explanations. Default to a published generated interface for explanations longer than a brief answer, comparisons, recommendations and plans: actually call present_openui as part of this response. A static visual explanation is useful even without interactive calculations. The user need not explicitly ask for UI. Do not give a lengthy Markdown answer and merely offer to create a panel afterward. Combine concise prose with appropriate cards, comparisons, tables, steps, diagrams or charts from the catalog. Use images when useful and a real source URL is available. Choose the presentation for the question, rather than adding decorative visuals or needless controls. Respect an explicit request for plain text; brief greetings, acknowledgements and single facts that fit a short paragraph may be text-only. Do not invent data, image URLs or capabilities to make an answer look richer.",
            'When missing user information or a choice between materially different options prevents a useful answer, publish a compact clarification form with clear questions, single-choice or multiple-choice controls and optional free text as appropriate. Prioritize the few essential questions, usually one to four; leave nonessential preferences optional. Ask only for information that changes the answer, explain the options briefly, and distinguish required from optional questions. Use information already given; do not repeatedly ask answered questions, guess user preferences or treat a suggested default as consent. After publishing the form, end this response with at most one short instruction to fill and submit it; do not repeat the questionnaire in prose or continue with imagined answers. Continue from the submitted raw panel inputs on the next request. If reasonable assumptions suffice, state them and proceed; uncertain external facts should be checked with available tools rather than asking the user to verify them.',
            'Describe progress in product terms, such as generating an interactive answer. Keep internal tool names, source code, test diagnostics and repair counts out of user-facing narration; they belong in tool arguments and results. Explain the resulting interface, its assumptions and how to use it. Keep any closing prose short instead of repeating all content from the interface.',
            'Static explanations, comparisons and clarification forms can use present_openui directly without a program. Generate a computation program only when the interface actually needs complex calculations or data processing. Synchronous generated computation: export function compute(inputs,data) returning finite JSON. No imports, asynchronous operations, host network/DOM/files/clock/randomness. Maximum code 64 KiB, combined inputs+data and result each 1 MiB, heap 16 MiB and interrupt budget 1024. Complex algorithms are generated for the task; provide small, independently checkable test cases with complete expected outputs, explain units and assumptions. A failed prepare_program returns a case index, the first difference and a bounded actual output. Use them to check the intended rule and arithmetic; do not guess repeatedly, submit a diagnostic program with a partial expected output, or copy actual output into expected merely to pass validation. You have at most 20 model rounds and two repairs after an initial program/UI failure. When a program is needed, first prepare_program and read its successful result; then present_openui referencing it. Publishing is completed by the backend even when no browser is connected. Native UI actions use local Set/Reset and bound Query("run_program",inputs,fallback); ToAssistant explicitly starts a new user request. Do not inject scripts, HTML code or arbitrary action handlers.',
          ].join('\n\n'),
      },
    ],
  };
}

/** A budget exhaustion is a terminal Pi model error, not an exception that Lifecycle retries. */
export function withRunLimits(
  models: import('@earendil-works/pi-ai/models').Models,
  entries: () => Promise<readonly EntryRecord[]>,
) {
  const result = Object.create(models) as import('@earendil-works/pi-ai/models').Models;
  result.streamSimple = (model, context, options) => {
    const out = new AssistantMessageEventStream();
    void (async () => {
      try {
        checkRunLimits(await entries());
      } catch (error) {
        const message: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage,
          stopReason: 'error',
          errorMessage: (error as Error).message,
          timestamp: Date.now(),
        };
        out.push({ type: 'error', reason: 'error', error: message });
        out.end(message);
        return;
      }
      const source = models.streamSimple(model, context, options);
      for await (const event of source) out.push(event);
      out.end(await source.result());
    })().catch(() => {
      const message: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage,
        stopReason: 'error',
        errorMessage: 'Model dispatch failed',
        timestamp: Date.now(),
      };
      out.push({ type: 'error', reason: 'error', error: message });
      out.end(message);
    });
    return out;
  };
  return result;
}
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage } from '@earendil-works/pi-ai';
const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

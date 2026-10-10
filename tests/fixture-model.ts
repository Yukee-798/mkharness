import { createModels } from '@earendil-works/pi-ai/models';
import type { Model, AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
export const model: Model<'openai-responses'> = {
  provider: 'fixture',
  id: 'fixture',
  name: 'Test only',
  api: 'openai-responses',
  baseUrl: 'https://fixture.invalid',
  reasoning: true,
  thinkingLevelMap: {
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  },
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4000,
};
export const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export function fixtureModels() {
  const models = createModels();
  const stream = (_model: Model<any>, context: TranscriptContext, _options?: unknown) => {
    const events = new AssistantMessageEventStream();
    const lastUser = context.messages.findLast((m) => m.role === 'user');
    const text =
      typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
    const last = context.messages.at(-1);
    const tool = text?.includes('ignores_cancel') && last?.role === 'user';
    let content: AssistantMessage['content'] | undefined;
    if (text?.includes('reordered_case') && last?.role === 'user')
      content = [
        {
          type: 'toolCall',
          id: 'same-call',
          name: 'prepare_program',
          arguments: {
            code: 'export function compute(){return {a:1,b:2}}',
            initialInputs: {},
            data: null,
            cases: [{ inputs: {}, expected: { b: 2, a: 1 } }],
          },
        },
      ];
    if (text?.includes('panel')) {
      if (last?.role === 'user')
        content = [
          {
            type: 'toolCall',
            id: 'same-call',
            name: 'prepare_program',
            arguments: {
              code: 'export function compute(i,d){return {double:Number(i.cost)*d.factor}}',
              initialInputs: { cost: '100' },
              data: { factor: 2 },
              cases: [{ inputs: { cost: '100' }, expected: { double: 200 } }],
            },
          },
        ];
      else if (last?.role === 'toolResult' && last.toolName === 'prepare_program')
        content = [
          {
            type: 'toolCall',
            id: 'same-call',
            name: 'present_openui',
            arguments: {
              programRef: (last.details as any)?.ref ?? 'missing',
              ui: '$cost = "100"\nresult = Query("run_program",{cost:$cost},{double:0})\nroot = Stack([Input("cost","Cost","number",null,$cost),Text("text","Interactive example")])',
            },
          },
        ];
    }
    if (text?.includes('invalid_program') || text?.includes('loop_model'))
      content = [
        {
          type: 'toolCall',
          id: 'same-call',
          name: 'prepare_program',
          arguments: {
            code: text.includes('invalid_program')
              ? 'export const bad=1'
              : 'export function compute(){return 0}',
            initialInputs: {},
            data: null,
            cases: [{ inputs: {}, expected: 0 }],
          },
        },
      ];
    if (
      text?.includes('invalid_program') &&
      context.messages.filter((m) => m.role === 'toolResult' && m.toolName === 'prepare_program')
        .length >= 3
    ) {
      content =
        last?.role === 'toolResult' && last.toolName === 'describe_text'
          ? [{ type: 'text', text: 'UI failed; ordinary tool still works.' }]
          : [
              {
                type: 'toolCall',
                id: 'same-call',
                name: 'describe_text',
                arguments: { text: 'abc' },
              },
            ];
    }
    if (text?.includes('skill activation')) {
      if (last?.role === 'user')
        content = [
          {
            type: 'toolCall',
            id: 'same-call',
            name: 'activate_skill',
            arguments: { name: 'source-comparison' },
          },
        ];
      else if (last?.role === 'toolResult' && last.toolName === 'activate_skill')
        content = [
          {
            type: 'toolCall',
            id: 'same-call',
            name: 'read_skill_resource',
            arguments: { name: 'source-comparison', path: 'references/checklist.md' },
          },
        ];
    }
    if (text?.includes('multiple_text_blocks'))
      content = [
        { type: 'text', text: 'First section' },
        { type: 'text', text: 'Second section' },
      ];
    if (text?.includes('reasoning_trace'))
      content = [
        {
          type: 'thinking',
          thinking: text.includes('reasoning_replacement')
            ? '重新核对来源。'
            : '核对来源，再比较结果。',
          thinkingSignature: 'fixture-private-signature',
        },
        { type: 'text', text: 'Comparison complete.' },
      ];
    if (
      context.messages.some(
        (m) =>
          m.role === 'system' &&
          typeof m.content === 'string' &&
          m.content.toLowerCase().includes('summariz'),
      )
    )
      content = [{ type: 'text', text: 'Summary of earlier work and its published panel.' }];
    const message: AssistantMessage = {
      role: 'assistant',
      content:
        content ??
        (tool
          ? [{ type: 'toolCall', id: 'same-call', name: 'ignores_cancel', arguments: {} }]
          : [
              {
                type: 'text',
                text: text?.includes('long_summary')
                  ? 'Context ' + 'x'.repeat(120000)
                  : 'Answer: ' + text,
              },
            ]),
      api: 'openai-responses',
      provider: _model.provider,
      model: _model.id,
      thinkingLevel:
        (_options as { reasoning?: AssistantMessage['thinkingLevel'] } | undefined)?.reasoning ??
        'off',
      usage: text?.includes('long_summary')
        ? { ...usage, output: 30000, totalTokens: 30000 }
        : usage,
      stopReason: content?.some((b) => b.type === 'toolCall') || tool ? 'toolUse' : 'stop',
      timestamp: Date.now(),
    };
    events.push({ type: 'start', partial: { ...message, content: [] } });
    if (text?.includes('reasoning_trace')) {
      const partial = (thinking: string, answer?: string): AssistantMessage => ({
        ...message,
        content: [
          { type: 'thinking', thinking, thinkingSignature: 'fixture-private-signature' },
          ...(answer === undefined ? [] : [{ type: 'text' as const, text: answer }]),
        ],
      });
      setTimeout(() => {
        events.push({ type: 'thinking_start', contentIndex: 0, partial: partial('') });
        events.push({
          type: 'thinking_delta',
          contentIndex: 0,
          delta: '核对来源',
          partial: partial('核对来源'),
        });
      }, 50);
      setTimeout(
        () => {
          if (text.includes('reasoning_replacement')) {
            events.push({
              type: 'thinking_end',
              contentIndex: 0,
              content: '重新核对来源。',
              partial: partial('重新核对来源。'),
            });
            return;
          }
          events.push({
            type: 'thinking_delta',
            contentIndex: 0,
            delta: '，再比较结果。',
            partial: partial('核对来源，再比较结果。'),
          });
          events.push({
            type: 'thinking_end',
            contentIndex: 0,
            content: '核对来源，再比较结果。',
            partial: partial('核对来源，再比较结果。'),
          });
          events.push({
            type: 'text_start',
            contentIndex: 1,
            partial: partial('核对来源，再比较结果。', ''),
          });
        },
        text.includes('reasoning_replacement') ? 500 : 100,
      );
    }
    setTimeout(
      () => {
        events.push({
          type: 'done',
          reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
          message,
        });
        events.end(message);
      },
      text?.includes('slow') ? 1000 : text?.includes('reasoning_trace') ? 200 : 30,
    );
    return events;
  };
  models.setProvider({
    id: 'fixture',
    name: 'Fixture',
    auth: {
      apiKey: {
        name: 'Fixture',
        resolve: async () => ({ auth: { apiKey: 'fixture' }, source: 'fixture' }),
      },
    },
    getModels: () => [
      model,
      {
        ...model,
        id: 'fixture-pro',
        name: 'Test Pro',
        thinkingLevelMap: { ...model.thinkingLevelMap, low: null },
      },
    ],
    stream,
    streamSimple: stream,
  });
  return models;
}

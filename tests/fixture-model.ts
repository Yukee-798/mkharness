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
export function fixtureModels(contextWindow = model.contextWindow) {
  const models = createModels();
  const stream = (_model: Model<any>, context: TranscriptContext, _options?: unknown) => {
    const events = new AssistantMessageEventStream();
    const lastUser = context.messages.findLast((m) => m.role === 'user');
    const text =
      typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content);
    const last = context.messages.at(-1);
    const tool = text?.includes('ignores_cancel') && last?.role === 'user';
    let content: AssistantMessage['content'] | undefined;
    if (text?.includes('image_generation_probe')) {
      const results = context.messages.filter(
        (m) => m.role === 'toolResult' && m.toolName === 'generate_image',
      );
      content =
        last?.role === 'user' || (text.includes('repeat') && results.length === 1)
          ? [
              {
                type: 'toolCall',
                id: `image-${results.length}`,
                name: 'generate_image',
                arguments: {
                  prompt: 'A blue circle on white',
                  title: 'Blue circle',
                  aspectRatio: '1:1',
                  resolution: '1K',
                },
              },
            ]
          : [{ type: 'text', text: 'Image request finished.' }];
    }
    if (text?.includes('custom_skill_probe')) {
      content =
        last?.role === 'user'
          ? [
              {
                type: 'toolCall',
                id: 'skill-activate',
                name: 'activate_skill',
                arguments: { name: 'delivery-guide' },
              },
            ]
          : last?.role === 'toolResult' && last.toolName === 'activate_skill'
            ? [
                {
                  type: 'toolCall',
                  id: 'skill-reference',
                  name: 'read_skill_resource',
                  arguments: { name: 'delivery-guide', path: 'references/checklist.md' },
                },
              ]
            : [{ type: 'text', text: 'Skill fixture finished.' }];
    }
    if (text?.includes('custom_mcp_probe')) {
      const selected = context.messages
        .flatMap((message) => (message.role === 'system' ? (message.toolsAdded ?? []) : []))
        .find((tool) => tool.name.startsWith('mcp_user_'));
      content =
        last?.role === 'user' && selected
          ? [
              {
                type: 'toolCall',
                id: 'custom-mcp',
                name: selected.name,
                arguments: { query: 'docs' },
              },
            ]
          : [{ type: 'text', text: 'MCP fixture finished.' }];
    }
    if (text?.includes('large tool outputs') && last?.role === 'user')
      content = [
        {
          type: 'toolCall',
          id: 'large-read',
          name: 'read_web',
          arguments: { url: 'https://public.example.test/page' },
        },
        {
          type: 'toolCall',
          id: 'large-search',
          name: 'search_web',
          arguments: { query: 'large sources' },
        },
        {
          type: 'toolCall',
          id: 'large-skill',
          name: 'activate_skill',
          arguments: { name: 'large-guide' },
        },
        {
          type: 'toolCall',
          id: 'large-resource',
          name: 'read_skill_resource',
          arguments: { name: 'large-guide', path: 'reference.md' },
        },
      ];
    if (text?.includes('fault seam') && last?.role === 'user')
      content = [{ type: 'toolCall', id: 'same-call', name: 'fault_probe', arguments: {} }];
    if (text?.includes('progress seam')) {
      const round = context.messages.filter(
        (message) => message.role === 'toolResult' && message.toolName === 'progress_probe',
      ).length;
      if (round < 2)
        content = [
          { type: 'toolCall', id: 'same-call', name: 'progress_probe', arguments: { round } },
        ];
    }
    if (text?.includes('remote example') && last?.role === 'user')
      content = [
        {
          type: 'toolCall',
          id: 'same-call',
          name: 'example_generate',
          arguments: { prompt: text.includes('changed') ? 'changed parameters' : 'hello' },
        },
      ];
    if (text?.includes('retry_remote') && last?.role === 'user')
      content = [
        {
          type: 'toolCall',
          id: 'same-call',
          name: 'example_generate',
          arguments: { prompt: 'model tries to replace the original prompt' },
        },
      ];
    if (text?.includes('recheck_remote') && last?.role === 'user')
      content = [{ type: 'toolCall', id: 'same-call', name: 'example_recheck', arguments: {} }];
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
    if (text?.includes('large_compute') && last?.role === 'user')
      content = [
        {
          type: 'toolCall',
          id: 'same-call',
          name: 'prepare_program',
          arguments: {
            code: 'export function compute(){return {value:"x".repeat(65536)}}',
            initialInputs: {},
            data: null,
            cases: [{ inputs: {}, expected: { value: 'x'.repeat(65536) } }],
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
              data: text.includes('large_panel')
                ? { factor: 2, padding: 'x'.repeat(900 * 1024) }
                : { factor: 2 },
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
              ui:
                '$cost = "100"\nresult = Query("run_program",{cost:$cost},{double:0})\nroot = Stack([Input("cost","Cost","number",null,$cost),Text("text",' +
                JSON.stringify(
                  text.includes('large_panel') ? 'x'.repeat(200 * 1024) : 'Interactive example',
                ) +
                ')])',
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
    if (text?.includes('mcp lookup') && last?.role === 'user')
      content = [
        {
          type: 'toolCall',
          id: 'same-call',
          name: 'mcp_reference_lookup',
          arguments: { query: 'hi' },
        },
      ];
    if (text?.includes('mcp unsafe retry'))
      content = [0, 1].map((index) => ({
        type: 'toolCall' as const,
        id: `unsafe-${index}`,
        name: 'mcp_reference_lookup',
        arguments: { query: 'same mutation' },
      }));
    if (text?.includes('mcp safe status') && last?.role === 'user')
      content = [
        {
          type: 'toolCall',
          id: 'status',
          name: 'mcp_reference_status',
          arguments: { query: 'read only' },
        },
      ];
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
    if (text?.includes('report_workspace_probe'))
      content =
        last?.role === 'user'
          ? [
              {
                type: 'toolCall',
                id: 'workspace-report',
                name: 'workspace_execute',
                arguments: {
                  name: 'report.publish',
                  input: {
                    title: 'Native report',
                    source: '<h1 id="summary">Native report</h1><script>window.answer=42</script>',
                  },
                },
              },
            ]
          : [{ type: 'text', text: 'Report published.' }];
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
      { ...model, contextWindow },
      {
        ...model,
        contextWindow,
        id: 'fixture-pro',
        input: ['text', 'image'],
        name: 'Test Pro',
        thinkingLevelMap: { ...model.thinkingLevelMap, low: null },
      },
    ],
    stream,
    streamSimple: stream,
  });
  return models;
}

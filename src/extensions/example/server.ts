import { defineTool, hook, ToolTask, type Extension } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';

/** Optional example: tool + prompt section + hook, installed only by developer configuration. */
export function exampleExtension(): Extension {
  return {
    name: 'example',
    sections: [
      {
        key: 'example-guidance',
        render: () =>
          'Use describe_text only when a text length is useful. It is a local read-only tool.',
      },
    ],
    tools: [
      defineTool({
        name: 'describe_text',
        description: 'Count Unicode characters in text.',
        parameters: Type.Object({ text: Type.String({ maxLength: 32000 }) }),
        replay: 'safe',
        execute: async ({ text }) => ({
          output: [{ type: 'text', text: JSON.stringify({ characters: Array.from(text).length }) }],
        }),
      }),
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: (call) =>
          call.name === 'describe_text' && typeof call.arguments.text !== 'string'
            ? { block: 'Text is required' }
            : undefined,
      }),
    ],
  };
}

import { defineTool, hook, ToolTask, type Extension } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { AppError } from '../shared/contracts';

export function validateExtensions(extensions: readonly Extension[]) {
  const seen = {
    extension: new Set<string>(),
    tool: new Set<string>(),
    task: new Set<string>(),
    section: new Set<string>(),
  };
  const add = (kind: keyof typeof seen, name: string) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(name))
      throw new AppError(503, 'invalid_extension_name', `${kind}: invalid stable name`);
    if (seen[kind].has(name) || (kind === 'task' && name.startsWith('pi.')))
      throw new AppError(503, 'duplicate_extension_name', `${kind}: duplicate name ${name}`);
    seen[kind].add(name);
  };
  for (const extension of extensions) {
    add('extension', extension.name);
    for (const tool of extension.tools ?? []) add('tool', tool.name);
    for (const task of extension.tasks ?? []) add('task', task.definition.name);
    for (const section of extension.sections ?? []) add('section', section.key);
  }
  for (const extension of extensions)
    for (const wrap of extension.wraps ?? []) {
      if ('tool' in wrap && !seen.tool.has(wrap.tool))
        throw new AppError(503, 'missing_wrap_target', wrap.tool);
    }
}

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
          content: [
            { type: 'text', text: JSON.stringify({ characters: Array.from(text).length }) },
          ],
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

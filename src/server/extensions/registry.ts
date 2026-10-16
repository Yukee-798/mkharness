import type { Extension } from '@earendil-works/pi-durable';
import { AppError } from '../../shared/contracts';

/** Validate native extension composition before registry installation. */
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

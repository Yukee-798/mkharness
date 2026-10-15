import { skills } from 'agents/harness/pi';
import { type SkillSource, type SkillContent, type SkillResource } from 'agents/skills';
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable';
import { AppError } from '../shared/contracts';
import { jsonText } from '../shared/json';
import { JSON_TOOL_OUTPUT_LIMITS } from './tool-output';

const pathAllowed = (path: string) =>
  !!path &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.includes(String.fromCharCode(0)) &&
  !path.split('/').some((p) => p === '..' || p === '.' || !p);
function textBounded(text: string) {
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024)
    throw new AppError(503, 'skill_resource_too_large');
}
/** Preflight trusted static sources, then delegate activation/catalog behavior to the native SDK. */
export async function staticSkills(sources: SkillSource[]): Promise<Extension> {
  const names = new Set<string>(),
    ids = new Set<string>();
  const loaded: SkillSource[] = [];
  for (const source of sources) {
    if (ids.has(source.id)) throw new AppError(503, 'duplicate_skill_source');
    ids.add(source.id);
    const bodies = new Map<string, SkillContent>(),
      resources = new Map<string, SkillResource>();
    let descriptors;
    try {
      descriptors = await source.list();
    } catch {
      throw new AppError(503, 'skill_source_unavailable');
    }
    for (const descriptor of descriptors) {
      if (names.has(descriptor.name)) throw new AppError(503, 'duplicate_skill_name');
      names.add(descriptor.name);
      let body;
      try {
        body = await source.load(descriptor.name);
      } catch {
        throw new AppError(503, 'skill_source_unavailable');
      }
      if (!body || body.name !== descriptor.name) throw new AppError(503, 'skill_body_missing');
      textBounded(body.body);
      bodies.set(body.name, body);
      for (const entry of body.resources ?? []) {
        if (!pathAllowed(entry.path)) throw new AppError(503, 'invalid_skill_path');
        const key = body.name + '/' + entry.path;
        if (resources.has(key)) throw new AppError(503, 'duplicate_skill_resource');
        let resource;
        try {
          resource = await source.readResource?.(body.name, entry.path);
        } catch {
          throw new AppError(503, 'skill_resource_unavailable');
        }
        if (!resource || resource.encoding === 'base64')
          throw new AppError(503, 'skill_resource_missing');
        textBounded(resource.content);
        resources.set(key, resource);
      }
    }
    loaded.push({
      id: source.id,
      fingerprint: source.fingerprint,
      list: async () => descriptors,
      load: async (name) => bodies.get(name) ?? null,
      readResource: async (name, path) => resources.get(name + '/' + path) ?? null,
    });
  }
  const extension = await skills(loaded);
  return {
    ...extension,
    wraps: (extension.tools ?? []).map((tool) => ({
      tool: tool.name,
      wrap: (original: ToolRegistration): ToolRegistration => ({
        ...original,
        outputLimits: JSON_TOOL_OUTPUT_LIMITS,
        execute: async (args, api, context) => {
          const result = await original.execute(args, api, context);
          try {
            jsonText(result.output ?? []);
          } catch {
            return { isError: true, output: [{ type: 'text', text: 'skill_output_too_large' }] };
          }
          const missing = (result.output ?? []).some(
            (c) => c.type === 'text' && /^Skill (resource )?not found:/.test(c.text),
          );
          return missing ? { ...result, isError: true } : result;
        },
      }),
    })),
  };
}

export function exampleSkillSource(): SkillSource {
  const content: SkillContent = {
    name: 'source-comparison',
    description: 'Compare public sources and explain uncertainties.',
    body: 'Use only enabled read_web/search_web tools. Keep source URLs and dates. Separate verified facts from assumptions. Consult references/checklist.md before presenting a comparison. This guidance grants no additional tools or permissions.',
    resources: [{ path: 'references/checklist.md', kind: 'reference' }],
  };
  return {
    id: 'app-guides',
    fingerprint: 'remote-research-v1',
    list: async () => [content],
    load: async (name) => (name === content.name ? content : null),
    readResource: async (name, path) =>
      name === content.name && path === 'references/checklist.md'
        ? {
            path,
            kind: 'reference',
            content:
              'Check dates, source scope and conflicting claims. Cite the original URLs. State missing evidence.',
          }
        : null,
  };
}

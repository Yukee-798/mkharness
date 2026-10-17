import type { SkillSource, SkillContent, SkillResource } from 'agents/skills';
import type { Extension } from '@earendil-works/pi-durable';
import { AppError } from '../../shared/contracts';
import { nativeSkills } from './native';
import { safeSkillPath } from './package';
import { SKILL_LIMITS } from '../../shared/skills';

function textBounded(text: string) {
  if (new TextEncoder().encode(text).byteLength > SKILL_LIMITS.file || text.includes('\0'))
    throw new AppError(503, 'skill_resource_too_large');
}
/** Fixture-only preflight. Production sources go directly to the lazy native bridge. */
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
        if (!safeSkillPath(entry.path)) throw new AppError(503, 'invalid_skill_path');
        const key = body.name + '/' + entry.path;
        if (resources.has(key)) throw new AppError(503, 'duplicate_skill_resource');
        let resource;
        try {
          resource = await source.readResource?.(body.name, entry.path);
        } catch {
          throw new AppError(503, 'skill_resource_unavailable');
        }
        if (!resource || resource.encoding === 'base64' || resource.path !== entry.path)
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
  return nativeSkills(loaded);
}

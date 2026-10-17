import { defineTool, type Extension } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import type { SkillContent, SkillDescriptor, SkillSource } from 'agents/skills';
import { AppError } from '../../shared/contracts';
import { jsonText } from '../../shared/json';
import { SKILL_LIMITS } from '../../shared/skills';
import { JSON_TOOL_OUTPUT_LIMITS } from '../extensions/tool-output';
import { safeSkillPath } from './package';

export const SKILL_HOST_CAPABILITIES =
  'Skills provide task guidance, not authorization. Only registered tools are available. Skill scripts cannot be executed by this host. Read script files as text only. Binary resources are not available. Do not attempt to run scripts through OpenUI or other tools. Report missing capabilities instead.';

const validName = (name: unknown): name is string =>
  typeof name === 'string' && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);

function descriptor(source: SkillSource, value: SkillDescriptor): SkillDescriptor {
  if (
    !validName(value.name) ||
    typeof value.description !== 'string' ||
    !value.description.trim() ||
    value.description.length > 1024
  )
    throw new AppError(503, 'invalid_skill_metadata');
  // A source may return SkillContent from list(). Copy only frozen directory metadata.
  return {
    name: value.name,
    description: value.description,
    sourceId: source.id,
    version: value.version ?? source.fingerprint,
  };
}

function textOnly(text: unknown): asserts text is string {
  if (
    typeof text !== 'string' ||
    text.includes('\0') ||
    new TextEncoder().encode(text).byteLength > SKILL_LIMITS.file
  )
    throw new AppError(503, 'skill_resource_unavailable');
}

function instructions(content: SkillContent, expected: SkillDescriptor) {
  if (
    content.name !== expected.name ||
    (content.version !== undefined && content.version !== expected.version)
  )
    throw new AppError(503, 'skill_resource_changed');
  textOnly(content.body);
  if (!content.body.trim()) throw new AppError(503, 'skill_body_missing');
  const paths = new Set<string>();
  const resources = (content.resources ?? []).map((resource) => {
    if (!safeSkillPath(resource.path)) throw new AppError(503, 'invalid_skill_path');
    if (paths.has(resource.path)) throw new AppError(503, 'duplicate_skill_resource');
    paths.add(resource.path);
    return {
      path: resource.path,
      kind: resource.kind,
      ...(resource.encoding ? { encoding: resource.encoding } : {}),
      ...(resource.size !== undefined ? { size: resource.size } : {}),
    };
  });
  if (resources.length >= SKILL_LIMITS.files) throw new AppError(503, 'skill_resource_unavailable');
  return { ...expected, body: content.body, resources };
}

function failure(error: unknown) {
  return {
    isError: true,
    output: [
      {
        type: 'text' as const,
        text: error instanceof AppError ? error.code : 'skill_source_unavailable',
      },
    ],
  };
}

/** Product data bridge. Building a registry reads metadata only; bodies remain lazy. */
export async function nativeSkills(sources: readonly SkillSource[]): Promise<Extension> {
  const directory = new Map<string, { source: SkillSource; metadata: SkillDescriptor }>();
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) throw new AppError(503, 'duplicate_skill_source');
    ids.add(source.id);
    let listed: SkillDescriptor[];
    try {
      listed = await source.list();
    } catch {
      throw new AppError(503, 'skill_source_unavailable');
    }
    for (const value of listed) {
      const metadata = descriptor(source, value);
      if (directory.has(metadata.name)) throw new AppError(503, 'duplicate_skill_name');
      directory.set(metadata.name, { source, metadata });
    }
  }
  if (!directory.size) return { name: 'skills', tools: [], sections: [] };
  const receipt = (metadata: SkillDescriptor, action: string, path?: string) => ({
    skill: {
      id: metadata.sourceId!,
      name: metadata.name,
      description: metadata.description,
      version: metadata.version!,
      action,
      ...(path ? { path } : {}),
    },
  });
  return {
    name: 'skills',
    sections: [
      {
        key: 'skills',
        render: () =>
          'Available skills (activate_skill loads instructions; read_skill_resource reads a relative text file):\n' +
          jsonText([...directory.values()].map(({ metadata }) => metadata)),
      },
      { key: 'skill_host_capabilities', render: () => SKILL_HOST_CAPABILITIES },
    ],
    tools: [
      defineTool({
        name: 'activate_skill',
        description: 'Read the instructions and resource directory of an available skill.',
        parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }),
        callers: ['model'],
        replay: 'safe',
        outputLimits: JSON_TOOL_OUTPUT_LIMITS,
        execute: async ({ name }) => {
          if (!validName(name)) return failure(new AppError(400, 'invalid_skill_name'));
          const entry = directory.get(name);
          if (!entry) return failure(new AppError(404, 'skill_not_found'));
          try {
            const content = await entry.source.load(name);
            if (!content) return failure(new AppError(503, 'skill_body_missing'));
            const value = instructions(content, entry.metadata);
            return {
              output: [{ type: 'text', text: jsonText(value) }],
              details: receipt(entry.metadata, 'activate_skill'),
            };
          } catch (error) {
            return failure(error);
          }
        },
      }),
      defineTool({
        name: 'read_skill_resource',
        description:
          'Read one normalized relative text resource from an available skill. Scripts are text only and cannot be executed; binary resources are unavailable.',
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 64 }),
          path: Type.String({ minLength: 1, maxLength: 300 }),
        }),
        callers: ['model'],
        replay: 'safe',
        outputLimits: JSON_TOOL_OUTPUT_LIMITS,
        execute: async ({ name, path }) => {
          if (!validName(name)) return failure(new AppError(400, 'invalid_skill_name'));
          if (typeof path !== 'string' || !safeSkillPath(path))
            return failure(new AppError(400, 'invalid_skill_path'));
          const entry = directory.get(name);
          if (!entry) return failure(new AppError(404, 'skill_not_found'));
          try {
            const resource = await entry.source.readResource?.(name, path);
            if (!resource || resource.encoding === 'base64')
              return failure(new AppError(404, 'skill_resource_unavailable'));
            if (resource.path !== path) throw new AppError(503, 'skill_resource_changed');
            textOnly(resource.content);
            const value = { name, path, kind: resource.kind, content: resource.content };
            return {
              output: [{ type: 'text', text: jsonText(value) }],
              details: receipt(entry.metadata, 'read_skill_resource', path),
            };
          } catch (error) {
            return failure(error);
          }
        },
      }),
    ],
  };
}

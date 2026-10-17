import { expect, it, vi } from 'vitest';
import {
  Harness,
  MemoryStorage,
  createRegistry,
  type Extension,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { SkillSource } from 'agents/skills';
import { nativeSkills } from '../../src/server/skills/native';
import { staticSkills } from '../../src/server/skills/static';
import { skillSource } from '../../src/server/skills/catalog';
import { importSkill, sha256 } from '../../src/server/skills/package';
import { SKILL_LIMITS } from '../../src/shared/skills';
import { canonicalJson } from '../../src/shared/json';
import { fixtureModels } from '../fixture-model';
import { BG } from '../../src/server/chat/context';
import { skillsContribution } from '../../src/extensions/skills/server';
import type { ContributionHost } from '../../src/server/extensions/contributions';

const markdown = '---\nname: guide\ndescription: Frozen guide\n---\nPRIVATE_INSTRUCTIONS';
const source = () => ({
  id: 'guide-source',
  fingerprint: 'frozen-version',
  list: vi.fn(async () => [
    { name: 'guide', description: 'Frozen guide', body: 'DO_NOT_PUT_THIS_IN_PROMPT' },
  ]),
  load: vi.fn(async () => ({
    name: 'guide',
    description: 'Frozen guide',
    body: 'PRIVATE_INSTRUCTIONS',
    allowedTools: '*',
    resources: [{ path: 'scripts/helper.js', kind: 'script' as const }],
  })),
  readResource: vi.fn(async () => ({
    path: 'scripts/helper.js',
    kind: 'script' as const,
    content: 'globalThis.__skillsScriptExecuted = true',
  })),
});
const tool = (extension: Extension, name: string) =>
  extension.tools!.find((entry) => entry.name === name)!;
const invoke = (entry: ToolRegistration, args: unknown) =>
  entry.execute(args, {} as never, {} as never);

it('commits activation and resource output through the unpatched native Pi 1.3 runtime', async () => {
  const registry = createRegistry();
  registry.install(
    await nativeSkills([
      {
        id: 'native-guide',
        fingerprint: 'frozen',
        list: async () => [{ name: 'delivery-guide', description: 'Frozen native guide' }],
        load: async () => ({
          name: 'delivery-guide',
          description: 'Frozen native guide',
          body: 'NATIVE_PRIVATE_BODY',
          resources: [{ path: 'references/checklist.md', kind: 'reference' }],
        }),
        readResource: async () => ({
          path: 'references/checklist.md',
          kind: 'reference',
          content: 'NATIVE_PRIVATE_RESOURCE',
        }),
      },
    ]),
  );
  const pi = await Harness.open(new MemoryStorage(), { registry, models: fixtureModels() }, BG);
  try {
    const conversation = await pi.root(BG, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    await conversation.submit({ type: 'input', content: 'custom_skill_probe' }, BG);
    await conversation.waitForIdle(BG);
    const results = (await conversation.entries({}, 100, undefined, BG)).items
      .toSorted((left, right) => Number(left.id) - Number(right.id))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === 'toolResult');
    expect(results.map((message) => message.toolName)).toEqual([
      'activate_skill',
      'read_skill_resource',
    ]);
    expect(results.every((message) => !message.isError)).toBe(true);
    expect(JSON.stringify(results)).toContain('NATIVE_PRIVATE_BODY');
    expect(JSON.stringify(results)).toContain('NATIVE_PRIVATE_RESOURCE');
    expect(results[0]!.details).toMatchObject({
      skill: { id: 'native-guide', version: 'frozen', action: 'activate_skill' },
    });
  } finally {
    await pi.close(BG);
  }
});

it('builds the native catalog from metadata and reads bodies only when a tool runs', async () => {
  const data = source();
  const extension = await nativeSkills([data]);
  const prompt = await extension.sections![0]!.render({} as never, {} as never);
  expect(prompt).toContain('Frozen guide');
  expect(prompt).not.toContain('DO_NOT_PUT_THIS_IN_PROMPT');
  expect(data.load).not.toHaveBeenCalled();
  expect(data.readResource).not.toHaveBeenCalled();
  expect(extension.name).toBe('skills');
  expect(extension.tools!.map((entry) => entry.name)).toEqual([
    'activate_skill',
    'read_skill_resource',
  ]);
  const result = await invoke(tool(extension, 'activate_skill'), { name: 'guide' });
  expect(result).toMatchObject({
    output: [{ type: 'text', text: expect.stringContaining('PRIVATE_INSTRUCTIONS') }],
    details: { skill: { id: data.id, name: 'guide', version: data.fingerprint } },
  });
  expect(result).not.toHaveProperty('content');
  expect(extension.tools!.every((entry) => entry.replay === 'safe')).toBe(true);
  expect((await nativeSkills([])).tools).toEqual([]);
});

it('keeps resource reads relative, bounded, text only, and returns failures through output', async () => {
  const data = source();
  const extension = await nativeSkills([data]);
  const read = tool(extension, 'read_skill_resource');
  for (const path of ['../escape', '/absolute', 'C:/escape', 'a\\b', 'a/./b', 'a\0b'])
    expect(await invoke(read, { name: 'guide', path })).toMatchObject({ isError: true });
  expect(data.readResource).not.toHaveBeenCalled();
  const script = await invoke(read, { name: 'guide', path: 'scripts/helper.js' });
  expect(JSON.stringify(script)).toContain('__skillsScriptExecuted');
  expect((globalThis as Record<string, unknown>).__skillsScriptExecuted).toBeUndefined();
  for (const resource of [
    null,
    { path: 'scripts/helper.js', kind: 'script', content: 'AA==', encoding: 'base64' },
    { path: 'other.js', kind: 'script', content: 'wrong path' },
    { path: 'scripts/helper.js', kind: 'script', content: 'x'.repeat(SKILL_LIMITS.file + 1) },
    { path: 'scripts/helper.js', kind: 'script', content: 'embedded\0null' },
  ]) {
    data.readResource.mockResolvedValueOnce(resource as never);
    expect(await invoke(read, { name: 'guide', path: 'scripts/helper.js' })).toMatchObject({
      isError: true,
      output: [{ type: 'text' }],
    });
  }
  data.load.mockRejectedValueOnce(new Error('secret backend message'));
  const failure = await invoke(tool(extension, 'activate_skill'), { name: 'guide' });
  expect(failure).toMatchObject({ isError: true });
  expect(JSON.stringify(failure)).not.toContain('secret backend message');
  expect(await invoke(tool(extension, 'activate_skill'), { name: 'missing' })).toMatchObject({
    isError: true,
  });
});

it('rejects ambiguous directories and confines eager source reads to static fixtures', async () => {
  const data = source();
  await expect(nativeSkills([data, data])).rejects.toThrow('duplicate_skill_source');
  await expect(nativeSkills([data, { ...source(), id: 'other' }])).rejects.toThrow(
    'duplicate_skill_name',
  );
  await expect(
    nativeSkills([
      {
        ...data,
        list: async () => {
          throw new Error('offline');
        },
      },
    ]),
  ).rejects.toThrow('skill_source_unavailable');
  expect(data.load).not.toHaveBeenCalled();
  await staticSkills([data]);
  expect(data.load).toHaveBeenCalledOnce();
  expect(data.readResource).toHaveBeenCalledOnce();
});

it('uses frozen metadata without touching D1/R2 and checks owner, immutable manifest, hash and UTF-8 on read', async () => {
  const imported = await importSkill(new TextEncoder().encode(markdown), 'SKILL.md');
  const binding = {
    id: 'skill-id',
    name: imported.preview.name,
    description: imported.preview.description,
    version: imported.preview.version,
  };
  const object = vi.fn(async () => {
    const bytes = new TextEncoder().encode(markdown);
    return { size: bytes.length, arrayBuffer: async () => bytes.buffer };
  });
  const row = { prefix: 'private/owner/frozen/', preview: JSON.stringify(imported.preview) };
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  const environment = { DB: { prepare }, SKILL_FILES: { get: object } } as unknown as Env;
  const data: SkillSource = await skillSource(environment, 'owner', binding);
  expect(await data.list()).toMatchObject([{ name: binding.name, version: binding.version }]);
  const host = {
    ownerId: 'owner',
    conversationId: 'chat-id',
    skillBindings: [binding],
  } as ContributionHost;
  const contribution = await skillsContribution(environment, host);
  const extension = contribution.extension!;
  expect(await skillsContribution(environment, { ...host, skillBindings: [] })).toEqual({
    id: 'skills',
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(object).not.toHaveBeenCalled();
  const activate = tool(extension, 'activate_skill');
  expect(await invoke(activate, { name: 'guide' })).not.toHaveProperty('isError', true);
  expect(bind).toHaveBeenLastCalledWith('owner', binding.id, binding.version);
  expect(object).toHaveBeenLastCalledWith(row.prefix + 'SKILL.md');
  first.mockResolvedValueOnce(null as never);
  expect(await invoke(activate, { name: 'guide' })).toMatchObject({ isError: true });
  const changed = { ...imported.preview, files: [{ ...imported.preview.files[0], size: 1 }] };
  first.mockResolvedValueOnce({ ...row, preview: JSON.stringify(changed) });
  expect(await invoke(activate, { name: 'guide' })).toMatchObject({ isError: true });
  object.mockResolvedValueOnce({
    size: imported.preview.files[0]!.size,
    arrayBuffer: async () => new TextEncoder().encode('x'.repeat(markdown.length)).buffer,
  });
  expect(await invoke(activate, { name: 'guide' })).toMatchObject({ isError: true });
  const invalid = new Uint8Array([0xff]);
  const invalidFile = { ...imported.preview.files[0]!, size: 1, sha256: await sha256(invalid) };
  const invalidVersion = await sha256(canonicalJson([invalidFile]));
  first.mockResolvedValueOnce({
    ...row,
    preview: JSON.stringify({ ...imported.preview, version: invalidVersion, files: [invalidFile] }),
  });
  object.mockResolvedValueOnce({ size: 1, arrayBuffer: async () => invalid.buffer });
  const invalidData = await skillSource(environment, 'owner', {
    ...binding,
    version: invalidVersion,
  });
  const invalidExtension = await nativeSkills([invalidData]);
  expect(await invoke(tool(invalidExtension, 'activate_skill'), { name: 'guide' })).toMatchObject({
    isError: true,
    output: [{ type: 'text', text: 'skill_resource_unavailable' }],
  });
});

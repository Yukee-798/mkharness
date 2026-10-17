import { expect, it } from 'vitest';
import { staticSkills } from '../../src/server/skills/static';
const source = () => ({
  id: 'guide',
  fingerprint: 'v1',
  list: async () => [{ name: 'guide', description: 'Tool guidance' }],
  load: async () => ({
    name: 'guide',
    description: 'Tool guidance',
    body: 'PRIVATE_BODY_MARKER',
    resources: [{ path: 'script.js', kind: 'script' as const }],
  }),
  readResource: async () => ({
    path: 'script.js',
    kind: 'script' as const,
    content: 'globalThis.__executed = true',
  }),
});
const invoke = (tool: any, args: any) => tool.execute(args, {}, {});
it('puts only the directory in the prompt, activating instructions through a native tool', async () => {
  const extension = await staticSkills([source()]);
  const prompt = await extension.sections![0].render({} as any, {} as any);
  expect(prompt).not.toContain('PRIVATE_BODY_MARKER');
  const result = await invoke(extension.tools![0], { name: 'guide' });
  expect(JSON.stringify(result)).toContain('PRIVATE_BODY_MARKER');
  expect((await staticSkills([])).tools).toHaveLength(0); // Ablation: bridge removed.
});
it('rejects duplicate names, failed sources and escaped paths; scripts remain text', async () => {
  await expect(staticSkills([source(), source()])).rejects.toThrow();
  await expect(
    staticSkills([
      {
        ...source(),
        list: async () => {
          throw new Error('offline');
        },
      },
    ]),
  ).rejects.toThrow('skill_source_unavailable');
  const extension = await staticSkills([source()]);
  const read = extension.tools!.find((t) => t.name === 'read_skill_resource')!;
  expect(await invoke(read, { name: 'guide', path: '../script.js' })).toMatchObject({
    isError: true,
  });
  expect(await invoke(read, { name: 'guide', path: 'missing' })).toMatchObject({ isError: true });
  expect(JSON.stringify(await invoke(read, { name: 'guide', path: 'script.js' }))).toContain(
    '__executed',
  );
  expect((globalThis as any).__executed).toBeUndefined();
});

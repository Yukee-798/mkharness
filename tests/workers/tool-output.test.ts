import { extensionConfiguration } from '../../src/extensions/configuration';
import { Harness, MemoryStorage, createRegistry, type Extension } from '@earendil-works/pi-durable';
import { it, expect, vi } from 'vitest';
import { webTools } from '../../src/server/web';
import { staticSkills } from '../../src/server/skills';
import { fixtureModels } from '../fixture-model';
import { BG } from '../../src/server/conversation';
import { applicationExtensions } from '../../src/server/assembly';

it.each([
  { key: undefined, enabled: false },
  { key: ' \t\n', enabled: false },
  { key: 'fixture-key', enabled: true },
])('native model tool catalog respects search configuration: %j', async ({ key, enabled }) => {
  const registry = createRegistry();
  for (const extension of await applicationExtensions(
    { TAVILY_API_KEY: key } as unknown as Env,
    async () => [],
    undefined,
    { ...extensionConfiguration, openui: { enabled: false } },
  ))
    registry.install(extension);
  const names = registry
    .snapshot()
    .tools()
    .map(({ tool }) => tool.name);
  expect(names).toContain('read_web');
  expect(names.includes('search_web')).toBe(enabled);
  const models = fixtureModels();
  const provider = models.getProvider('fixture')!;
  let offered: string[] | undefined;
  models.setProvider({
    ...provider,
    streamSimple: (model, context, options) => {
      offered = context.messages.flatMap((message) =>
        message.role === 'system' ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
      );
      return provider.streamSimple(model, context, options);
    },
  });
  const pi = await Harness.open(new MemoryStorage(), { models, registry }, BG);
  try {
    const root = await pi.root(BG, {
      agent: { model: { provider: 'fixture', modelId: 'fixture' } },
    });
    await root.submit({ type: 'input', content: 'configured tool catalog' }, BG);
    await root.waitForIdle(BG);
    expect(offered).toContain('read_web');
    expect(offered?.includes('search_web')).toBe(enabled);
  } finally {
    await pi.close(BG);
  }
});

it.each([true, false])(
  'native Pi retains accepted large Web and Skill output (budget bridge=%s)',
  async (bridge) => {
    const text = 'x'.repeat(64000) + 'END_OF_SOURCE';
    const sources = Array.from({ length: 5 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://sources.example.test/${index}`,
      content: text,
    }));
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'cloudflare-dns.com')
        return Response.json({ Answer: [{ type: 1, data: '1.1.1.1' }] });
      if (url.hostname === 'api.tavily.com') return Response.json({ results: sources });
      return new Response(text, { headers: { 'Content-Type': 'text/plain' } });
    });
    let pi: Harness | undefined;
    try {
      const skill = await staticSkills([
        {
          id: 'large-static',
          fingerprint: 'v1',
          list: async () => [{ name: 'large-guide', description: 'Large static guide' }],
          load: async () => ({
            name: 'large-guide',
            description: 'Large static guide',
            body: text,
            resources: [{ path: 'reference.md', kind: 'reference' }],
          }),
          readResource: async () => ({ path: 'reference.md', kind: 'reference', content: text }),
        },
      ]);
      const registry = createRegistry();
      for (const extension of [webTools('test-only'), skill]) {
        const selected: Extension = bridge
          ? extension
          : {
              ...extension,
              tools: extension.tools?.map((tool) => ({ ...tool, outputLimits: undefined })),
              wraps: [], // Negative control removes the Skill wrapper as well as Web limits.
            };
        registry.install(selected);
      }
      pi = await Harness.open(
        new MemoryStorage(),
        { models: fixtureModels(), registry, settings: { toolExecution: 'sequential' } },
        BG,
      );
      const root = await pi.root(BG, {
        agent: { model: { provider: 'fixture', modelId: 'fixture' } },
      });
      await root.submit({ type: 'input', content: 'large tool outputs' }, BG);
      await root.waitForIdle(BG);
      const results = (await root.entries({}, 100, undefined, BG)).items
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === 'toolResult');
      expect(results).toHaveLength(4);
      const output = (name: string) => {
        const block = results.find((result) => result.toolName === name)?.content[0];
        if (block?.type !== 'text') throw new Error(`Missing text result: ${name}`);
        return block.text;
      };
      if (bridge) {
        expect(JSON.parse(output('read_web'))).toMatchObject({ text, truncated: false });
        expect(JSON.parse(output('search_web')).results).toEqual(sources);
        expect(output('activate_skill')).toContain(text);
        expect(output('read_skill_resource')).toContain(text);
        expect(results.every((result) => !result.isError)).toBe(true);
      } else {
        expect(() => JSON.parse(output('read_web'))).toThrow();
        expect(output('search_web')).not.toContain(sources.at(-1)!.url);
        expect(output('activate_skill')).not.toContain('END_OF_SOURCE');
        expect(output('read_skill_resource')).not.toContain('END_OF_SOURCE');
      }
    } finally {
      await pi?.close(BG);
      network.mockRestore();
    }
  },
);

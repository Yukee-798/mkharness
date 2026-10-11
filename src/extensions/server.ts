import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ServerContribution } from '../server/contributions';
type Context = { env: Env; entries: () => Promise<readonly EntryRecord[]> };
type Definition = {
  id: string;
  enabled: (env: Env) => boolean;
  create: (context: Context) => Promise<ServerContribution>;
};

/** The only server activation list. Listing IDs never executes a factory. */
export const definitions: readonly Definition[] = [
  {
    id: 'web',
    enabled: () => true,
    create: async ({ env }) => {
      const { webTools } = await import('../server/web');
      return {
        id: 'web',
        extension: webTools((env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY),
      };
    },
  },
  {
    id: 'openui',
    enabled: (env) => (env as Env & { ENABLE_GENERATIVE_UI?: string }).ENABLE_GENERATIVE_UI !== '0',
    create: async ({ entries }) => {
      const { openuiContribution } = await import('./openui/server');
      return openuiContribution(entries);
    },
  },
  {
    id: 'example',
    enabled: (env) =>
      (env as Env & { ENABLE_EXAMPLE_EXTENSION?: string }).ENABLE_EXAMPLE_EXTENSION === '1',
    create: async () => {
      const { exampleExtension } = await import('../server/extensions');
      return { id: 'example', extension: exampleExtension() };
    },
  },
  {
    id: 'skills-example',
    enabled: (env) => (env as Env & { ENABLE_EXAMPLE_SKILL?: string }).ENABLE_EXAMPLE_SKILL === '1',
    create: async () => {
      const { staticSkills, exampleSkillSource } = await import('../server/skills');
      return { id: 'skills-example', extension: await staticSkills([exampleSkillSource()]) };
    },
  },
];
export const enabledDefinitions = (env: Env) =>
  definitions.filter((definition) => definition.enabled(env));
export const extensionIds = (env: Env) =>
  enabledDefinitions(env).map((definition) => definition.id);

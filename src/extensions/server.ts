import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ServerContribution } from '../server/contributions';
import { validateContributionIds } from '../server/contributions';
type Context = { env: Env; entries: () => Promise<readonly EntryRecord[]> };
type Definition = {
  id: string;
  enabled?: (env: Env) => boolean;
  create: (context: Context) => Promise<ServerContribution>;
};

/** Add to definitions to opt into the sample; declaring a tool is not installing it. */
export const exampleDefinition: Definition = {
  id: 'example',
  create: async () => {
    const { exampleExtension } = await import('../server/extensions');
    return { id: 'example', extension: exampleExtension() };
  },
};

/** The only server activation list. Listing IDs never executes a factory. */
export const definitions: readonly Definition[] = [
  {
    id: 'timing',
    create: async () => {
      const { timingContribution } = await import('./timing/server');
      return timingContribution();
    },
  },
  {
    id: 'web',
    create: async ({ env }) => {
      const { webTools } = await import('../server/web');
      const { projectSources } = await import('./web/sources');
      return {
        id: 'web',
        extension: webTools((env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY),
        projectState: projectSources,
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
    id: 'reply',
    create: async () => {
      const { replyContribution } = await import('./reply/server');
      return replyContribution();
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
export const enabledDefinitions = (env: Env) => {
  const enabled = definitions.filter((definition) => definition.enabled?.(env) ?? true);
  validateContributionIds(enabled.map((definition) => definition.id));
  return enabled;
};
export const extensionIds = (env: Env) =>
  enabledDefinitions(env).map((definition) => definition.id);

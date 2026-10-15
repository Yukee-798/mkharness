import {
  extensionConfiguration,
  extensionEnabled,
  validateConfiguration,
  type ExtensionConfiguration,
} from './configuration';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ServerContribution, ContributionHost } from '../server/contributions';
import { validateContributionIds } from '../server/contributions';
type Context = {
  env: Env;
  entries: () => Promise<readonly EntryRecord[]>;
  host?: ContributionHost;
};
type Definition = {
  id: string;
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
    id: 'async-example',
    create: async ({ env, host }) => {
      const { asyncExampleContribution } = await import('./async-example/server');
      const { remoteConfiguration } = await import('./async-example/runtime');
      return asyncExampleContribution(
        remoteConfiguration(env as unknown as Record<string, unknown>),
        host,
      );
    },
  },
  exampleDefinition,
  {
    id: 'skills-example',
    create: async () => {
      const { staticSkills, exampleSkillSource } = await import('../server/skills');
      return { id: 'skills-example', extension: await staticSkills([exampleSkillSource()]) };
    },
  },
];
export const enabledDefinitions = (config: ExtensionConfiguration = extensionConfiguration) => {
  validateContributionIds(definitions.map((definition) => definition.id));
  validateConfiguration(
    config,
    definitions.map((definition) => definition.id),
  );
  return definitions.filter((definition) => extensionEnabled(definition.id, config));
};
export const extensionIds = (config: ExtensionConfiguration = extensionConfiguration) =>
  enabledDefinitions(config).map((definition) => definition.id);

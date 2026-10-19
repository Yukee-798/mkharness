import {
  extensionConfiguration,
  extensionEnabled,
  validateConfiguration,
  type ExtensionConfiguration,
} from './configuration';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ServerContribution, ContributionHost } from '../server/extensions/contributions';
import { validateContributionIds } from '../server/extensions/contributions';
type Context = {
  env: Env;
  entries: (nativeConversationId: number) => Promise<readonly EntryRecord[]>;
  host?: ContributionHost;
  configuration?: ExtensionConfiguration;
};
type Definition = {
  id: string;
  create: (context: Context) => Promise<ServerContribution>;
};

/** Registered sample; enable it through extensions.config.ts. */
export const exampleDefinition: Definition = {
  id: 'example',
  create: async () => {
    const { exampleExtension } = await import('./example/server');
    return { id: 'example', extension: exampleExtension() };
  },
};

/** The only server activation list. Listing IDs never executes a factory. */
export const definitions: readonly Definition[] = [
  {
    id: 'workspace',
    create: async ({ host }) => {
      const { workspaceContribution } = await import('../server/workspace/extension');
      return workspaceContribution(host);
    },
  },
  {
    id: 'images',
    create: async ({ env, host }) => {
      const { configuredImages } = await import('./images/server');
      return configuredImages(env as unknown as Record<string, unknown>, host);
    },
  },
  {
    id: 'skills',
    create: async ({ env, host, configuration = extensionConfiguration }) => {
      const { skillsContribution } = await import('./skills/server');
      return skillsContribution(env, host, extensionEnabled('skills-example', configuration));
    },
  },
  {
    id: 'mcp',
    create: async ({ env, host, configuration = extensionConfiguration }) => {
      const { userMcpContribution } = await import('./mcp/server');
      return userMcpContribution(env, host, configuration);
    },
  },
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
      const { webTools } = await import('./web/server');
      const { projectSources } = await import('./web/sources');
      return {
        id: 'web',
        extension: webTools((env as Env & { TAVILY_API_KEY?: string }).TAVILY_API_KEY),
        projectHistory: (facts) =>
          Object.fromEntries(
            Object.entries(projectSources(facts).replies).map(([id, sources]) => [
              id,
              { replies: { [id]: sources } },
            ]),
          ),
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
    create: async ({ configuration = extensionConfiguration }) => {
      // Both source kinds share one native Skills extension and one pair of tools.
      if (extensionEnabled('skills', configuration)) return { id: 'skills-example' };
      const { staticSkills } = await import('../server/skills/static');
      const { exampleSkillSource } = await import('./skills/example');
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

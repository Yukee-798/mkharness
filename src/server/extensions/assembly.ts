import { scenarioRegistry } from '../../scenarios/server';
import { extensionEnabled } from '../../extensions/configuration';
import {
  extensionConfiguration,
  type ExtensionConfiguration,
} from '../../extensions/configuration';
import type { EntryRecord } from '@earendil-works/pi-durable';
import { collectContributions, type ContributionHost } from './contributions';
import { enabledDefinitions } from '../../extensions/server';
import { AppError } from '../../shared/contracts';

export async function applicationContributions(
  env: Env,
  entries: (nativeConversationId: number) => Promise<readonly EntryRecord[]>,
  host?: ContributionHost,
  config: ExtensionConfiguration = extensionConfiguration,
) {
  const contributions = await Promise.all(
    enabledDefinitions(config).map(async (definition) => {
      const contribution = await definition.create({ env, entries, host, configuration: config });
      if (contribution.id !== definition.id) throw new AppError(503, 'extension_identity_mismatch');
      return contribution;
    }),
  );
  if (host?.scenario && extensionEnabled('workspace', config)) {
    for (const pack of scenarioRegistry.scene(host.scenario.kind).packs)
      if (pack.contribute)
        contributions.push({
          ...(await pack.contribute(host, {
            env,
            config: scenarioRegistry.scenarios.packs.find((m) => m.id === pack.id)?.config ?? {},
          })),
          id: `scenario.${pack.id}`,
        });
  }
  return collectContributions(contributions);
}

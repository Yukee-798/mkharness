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
  entries: () => Promise<readonly EntryRecord[]>,
  host?: ContributionHost,
  config: ExtensionConfiguration = extensionConfiguration,
) {
  return collectContributions(
    await Promise.all(
      enabledDefinitions(config).map(async (definition) => {
        const contribution = await definition.create({ env, entries, host, configuration: config });
        if (contribution.id !== definition.id)
          throw new AppError(503, 'extension_identity_mismatch');
        return contribution;
      }),
    ),
  );
}

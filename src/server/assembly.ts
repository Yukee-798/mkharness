import type { Extension, EntryRecord } from '@earendil-works/pi-durable';
import { runLimits, toolBudget } from './limits';
import { collectContributions } from './contributions';
import { enabledDefinitions } from '../extensions/server';
import { AppError } from '../shared/contracts';

export async function applicationContributions(
  env: Env,
  entries: () => Promise<readonly EntryRecord[]>,
) {
  return collectContributions(
    await Promise.all(
      enabledDefinitions(env).map(async (definition) => {
        const contribution = await definition.create({ env, entries });
        if (contribution.id !== definition.id)
          throw new AppError(503, 'extension_identity_mismatch');
        return contribution;
      }),
    ),
  );
}

/** Developer-owned composition point. Return native Pi extensions; do not download executable code. */
export async function applicationExtensions(
  env: Env,
  entries: () => Promise<readonly EntryRecord[]>,
): Promise<Extension[]> {
  return [
    runLimits(entries, toolBudget(env as unknown as Record<string, unknown>)),
    ...(await applicationContributions(env, entries)).flatMap((contribution) =>
      contribution.extension ? [contribution.extension] : [],
    ),
  ];
}

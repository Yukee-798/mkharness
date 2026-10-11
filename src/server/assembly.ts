import type { Extension, EntryRecord } from '@earendil-works/pi-durable';
import { runLimits, toolBudget } from './limits';
import { collectContributions } from './contributions';
import { enabledDefinitions } from '../extensions/server';

export async function applicationContributions(
  env: Env,
  entries: () => Promise<readonly EntryRecord[]>,
) {
  return collectContributions(
    await Promise.all(
      enabledDefinitions(env).map((definition) => definition.create({ env, entries })),
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

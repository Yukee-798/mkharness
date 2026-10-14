import type { RunCommand } from '../shared/contracts';
import { jsonEqual } from '../shared/compute';
/** Retain an unacknowledged command so explicit retry uses the same Pi operation id. */
export function createSubmitter(
  post: (command: RunCommand) => Promise<unknown>,
  previous?: () => RunCommand | null | undefined,
) {
  let uncertain: RunCommand | undefined;
  return async (
    text: string,
    source?: RunCommand['source'],
    config?: RunCommand['config'],
    images?: RunCommand['images'],
  ) => {
    const input = {
      text: text.trim(),
      ...(source ? { source } : {}),
      ...(config ? { config } : {}),
      ...(images?.length ? { images: structuredClone(images) } : {}),
    };
    // A navigation may replace the composer while its HTTP receipt is pending.
    // Query's mutation cache retains that failed command for the next composer.
    // null means acknowledged elsewhere; undefined keeps local create uncertainty.
    const retained = previous?.();
    if (retained !== undefined) uncertain = retained ?? undefined;
    if (
      !uncertain ||
      !jsonEqual(
        {
          text: uncertain.text,
          ...(uncertain.source ? { source: uncertain.source } : {}),
          ...(uncertain.config ? { config: uncertain.config } : {}),
          ...(uncertain.images ? { images: uncertain.images } : {}),
        },
        input,
      )
    )
      uncertain = { runId: crypto.randomUUID(), ...input };
    const command = uncertain;
    await post(command);
    if (uncertain === command) uncertain = undefined;
  };
}

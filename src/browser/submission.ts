import type { RunCommand } from '../shared/contracts';
import { jsonEqual } from '../shared/compute';
/** Retain an unacknowledged command so explicit retry uses the same Pi operation id. */
export function createSubmitter(post: (command: RunCommand) => Promise<unknown>) {
  let uncertain: RunCommand | undefined;
  return async (text: string, source?: RunCommand['source'], config?: RunCommand['config']) => {
    const input = {
      text: text.trim(),
      ...(source ? { source } : {}),
      ...(config ? { config } : {}),
    };
    if (
      !uncertain ||
      !jsonEqual(
        {
          text: uncertain.text,
          ...(uncertain.source ? { source: uncertain.source } : {}),
          ...(uncertain.config ? { config: uncertain.config } : {}),
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

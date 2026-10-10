import { expect, it } from 'vitest';
import { commandSchema } from '../../src/shared/contracts';
import { createSubmitter } from '../../src/browser/submission';
it('remote actions accept only a scoped original task reference', () => {
  const command = {
    runId: crypto.randomUUID(),
    text: 'retry',
    source: { action: 'retry_remote', taskId: 12 },
  };
  expect(commandSchema.safeParse(command).success).toBe(true);
  expect(
    commandSchema.safeParse({ ...command, source: { ...command.source, remoteId: 'arbitrary' } })
      .success,
  ).toBe(false);
  expect(
    commandSchema.safeParse({ ...command, source: { action: 'recheck_remote', taskId: -1 } })
      .success,
  ).toBe(false);
});
it('concurrent retries share one runId until the HTTP acceptance resolves', async () => {
  const accepts: (() => void)[] = [];
  const commands: unknown[] = [];
  const send = createSubmitter(async (command) => {
    commands.push(command);
    await new Promise<void>((r) => {
      accepts.push(r);
    });
  });
  const first = send('retry', { action: 'retry_remote', taskId: 12 } as any);
  const second = send('retry', { action: 'retry_remote', taskId: 12 } as any);
  expect(commands[0]).toEqual(commands[1]);
  accepts.forEach((accept) => accept());
  await Promise.all([first, second]);
});

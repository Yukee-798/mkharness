import {
  remoteActionPayload,
  remoteActionSource,
  remoteSource,
} from '../../src/extensions/async-example/contracts';
import { expect, it } from 'vitest';
import { commandSchema, storedRequestSchema } from '../../src/shared/contracts';
import { createSubmitter } from '../../src/browser/chat/session/submission';
it('remote actions accept only a scoped original task reference', () => {
  const command = {
    runId: crypto.randomUUID(),
    text: 'retry',
    source: remoteActionSource('retry', 12),
  };
  expect(commandSchema.safeParse(command).success).toBe(true);
  expect(remoteActionPayload.safeParse({ taskId: 12, remoteId: 'arbitrary' }).success).toBe(false);
  expect(remoteActionPayload.safeParse({ taskId: -1 }).success).toBe(false);
  expect(
    commandSchema.safeParse({ ...command, source: { action: 'retry_remote', taskId: 12 } }).success,
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
  const first = send('retry', remoteActionSource('retry', 12) as any);
  const second = send('retry', remoteActionSource('retry', 12) as any);
  expect(commands[0]).toEqual(commands[1]);
  accepts.forEach((accept) => accept());
  await Promise.all([first, second]);
});

it('already accepted legacy action receipts remain interpretable only by the example', () => {
  const legacy = { action: 'retry_remote', taskId: 12 };
  const saved = storedRequestSchema.parse({
    request: { runId: crypto.randomUUID(), text: 'retry', source: legacy },
    execution: {
      provider: 'fixture',
      modelId: 'fixture',
      thinkingLevel: 'off',
      credentialRef: { source: 'server', fingerprint: 'fixture' },
    },
  });
  expect(remoteSource(saved.request.source)).toEqual(legacy);
  expect(
    remoteSource({
      action: 'extension_action',
      extensionId: 'another',
      name: 'retry',
      payload: { taskId: 12 },
    }),
  ).toBeUndefined();
});

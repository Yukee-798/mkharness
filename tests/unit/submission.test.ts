import { it, expect } from 'vitest';
import { createSubmitter } from '../../src/browser/submission';
it('keeps the client operation id after an uncertain acknowledgement, and changes it after acceptance', async () => {
  const commands: any[] = [];
  let fail = true;
  const send = createSubmitter(async (command) => {
    commands.push(command);
    if (fail) {
      fail = false;
      throw new Error('ack lost');
    }
  });
  await expect(send('same')).rejects.toThrow();
  await send('same');
  expect(commands[0].runId).toBe(commands[1].runId);
  await send('same');
  expect(commands[2].runId).not.toBe(commands[1].runId);
});
it('includes model settings in idempotent retries and makes a new command when they change', async () => {
  const commands: any[] = [];
  const send = createSubmitter(async (command) => {
    commands.push(command);
    throw new Error('ack lost');
  });
  const config = { provider: 'fixture', modelId: 'flash', thinkingLevel: 'low' as const };
  await expect(send('same', undefined, config)).rejects.toThrow();
  await expect(send('same', undefined, config)).rejects.toThrow();
  expect(commands[1]).toEqual(commands[0]);
  await expect(send('same', undefined, { ...config, thinkingLevel: 'high' })).rejects.toThrow();
  expect(commands[2].runId).not.toBe(commands[0].runId);
  expect(commands[2].config.thinkingLevel).toBe('high');
});
it('inherits an uncertain command across composers and clears it after an external retry succeeds', async () => {
  const config = { provider: 'fixture', modelId: 'flash', thinkingLevel: 'low' as const };
  const retained = { runId: '11111111-1111-4111-8111-111111111111', text: 'same', config };
  let previous: typeof retained | null = retained;
  const commands: any[] = [];
  const send = createSubmitter(
    async (command) => {
      commands.push(command);
      throw new Error('ack lost');
    },
    () => previous,
  );
  await expect(send('same', undefined, config)).rejects.toThrow('ack lost');
  expect(commands[0]).toEqual(retained);
  previous = null; // The native mutation retained by another composer acknowledged the retry.
  await expect(send('same', undefined, config)).rejects.toThrow('ack lost');
  expect(commands[1].runId).not.toBe(retained.runId);
});

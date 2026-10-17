import { env, runInDurableObject } from './env';
import { expect, it } from 'vitest';
import { watchEvents, type AgentEvent } from '@earendil-works/pi-durable';
import { BG } from '../../src/server/chat/context';

it('native watch retains bounded progress and separates repeated provider ids by ToolTask input', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (instance) => {
    const root = await instance.root();
    const pi = await instance.harness.pi();
    const watch = await watchEvents(pi, root.id, BG);
    const events: AgentEvent[] = [];
    const identities: { assistant: number; callId: string }[] = [];
    let initialProgress: unknown;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    watch.start(async (batch) => {
      events.push(...batch);
      for (const event of batch) {
        if (event.type === 'tool_execution_update' && event.details && !initialProgress) {
          const attached = await watchEvents(pi, root.id, BG);
          initialProgress = attached.snapshot.tools[0];
          await attached.stop();
        }
        if (event.type === 'run_end') finish();
      }
    });
    await instance.submitRun({ runId: crypto.randomUUID(), text: 'progress seam' });
    await done;
    const tasks = await root.commit((tx) => tx.scanTasks({ conversationId: root.id }, 100), BG);
    for (const task of tasks.items) if (task.kind === 'pi.tool') identities.push(task.input as any);
    await watch.stop();
    expect(identities).toHaveLength(2);
    expect(identities.map((input) => input.callId)).toEqual(['same-call', 'same-call']);
    expect(identities[0]!.assistant).not.toBe(identities[1]!.assistant);
    expect(initialProgress).toMatchObject({
      callId: 'same-call',
      status: 'running',
      output: 'abc',
      details: { phase: 'first' },
    });
    const updates = events.filter((event) => event.type === 'tool_execution_update');
    expect(updates.some((event) => event.output && 'set' in event.output)).toBe(true);
    expect(updates.some((event) => event.output && 'append' in event.output)).toBe(true);
    expect(updates.some((event) => event.output && 'trimStart' in event.output)).toBe(true);
    expect(updates.filter((event) => event.details).at(-1)?.details).toEqual({
      round: 1,
      phase: 'last',
    });
    expect(events.filter((event) => event.type === 'tool_execution_end')).toHaveLength(2);
  });
});

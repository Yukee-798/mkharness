import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
it('observes exactly one durable submission, detach does not cancel, and completion can be attached again', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID()),
    first = crypto.randomUUID(),
    second = crypto.randomUUID();
  await stub.submitRun({ runId: first, text: 'slow first' });
  await stub.submitRun({ runId: second, text: 'second' });
  const observation = await stub.observeRun(first);
  expect(observation.headers.get('Content-Type')).toBe('text/event-stream');
  const reader = observation.body!.getReader();
  await reader.read();
  await reader.cancel();
  for (let i = 0; i < 150; i++) {
    if (!JSON.parse(await stub.snapshot()).pending.length) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const attach = await stub.observeRun(second);
  const events = (await attach.text())
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
  expect(events.filter((e) => e.type === 'RUN_STARTED')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'RUN_FINISHED')).toHaveLength(1);
  const history = events.find((e) => e.type === 'MESSAGES_SNAPSHOT');
  expect(history.messages.filter((m: any) => m.role === 'user')).toHaveLength(2);
  expect(await stub.observeRun(crypto.randomUUID()).then((r) => r.status)).toBe(404);
});

it('starts each streamed assistant message once when Pi has multiple text blocks', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID()),
    runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'slow multiple_text_blocks' });
  const events = (await (await stub.observeRun(runId)).text())
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
  const starts = events.filter((e) => e.type === 'TEXT_MESSAGE_START');
  expect(starts.length).toBeGreaterThan(0);
  expect(new Set(starts.map((e) => e.messageId)).size).toBe(starts.length);
  expect(
    events
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join(''),
  ).toBe('First section\nSecond section');
});

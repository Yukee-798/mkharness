import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
function events(body: string) {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}
async function untilDone(read: () => Promise<{ status: string } | undefined>) {
  for (let i = 0; i < 300; i++) {
    if ((await read())?.status === 'done') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not complete');
}
it.each(['slow observer race', 'progress seam'])(
  'does not close with an obsolete prefix when %s completes during observer initialization',
  async (text) => {
    const stub = env.CONVERSATIONS.getByName(crypto.randomUUID()),
      runId = crypto.randomUUID();
    await stub.submitRun({ runId, text });
    const body = await runInDurableObject(stub, async (instance) => {
      const projector = instance.progressProjector.bind(instance);
      instance.progressProjector = async () => {
        await untilDone(() => instance.submission(runId));
        return projector();
      };
      try {
        return await (await instance.observeRun(runId)).text();
      } finally {
        instance.progressProjector = projector;
      }
    });
    const attached = events(body);
    expect(attached.at(-1).type).toBe('RUN_FINISHED');
    const history = attached.findLast((event) => event.type === 'MESSAGES_SNAPSHOT').messages;
    expect(
      history.some(
        (message: any) => message.role === 'assistant' && message.content.includes(text),
      ),
    ).toBe(true);
    if (text === 'progress seam')
      expect(history.filter((message: any) => message.role === 'tool')).toHaveLength(2);
  },
);
it('finishes an attachment when completion precedes watch acquisition after the initial pending read', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID()),
    runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'slow before watch' });
  const body = await runInDurableObject(stub, async (instance) => {
    const read = instance.allEntries.bind(instance);
    instance.allEntries = async () => {
      const stale = await read();
      await untilDone(() => instance.submission(runId));
      return stale;
    };
    try {
      const response = await instance.observeRun(runId);
      const reader = response.body!.getReader();
      const timer = setTimeout(() => void reader.cancel(), 2000);
      const decoder = new TextDecoder();
      let body = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return body;
          body += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        clearTimeout(timer);
      }
    } finally {
      instance.allEntries = read;
    }
  });
  expect(events(body).at(-1).type).toBe('RUN_FINISHED');
  expect(body).toContain('slow before watch');
});
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

it('committed snapshots retain streamed identities across tool-only model rounds', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'slow panel' });
  const events = (await (await stub.observeRun(runId)).text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
  const starts = events.filter((event) => event.type === 'TOOL_CALL_START');
  expect(starts).toHaveLength(2);
  // The fixture deliberately reuses the provider call id in the next model round.
  expect(starts[0].toolCallId).not.toBe(starts[1].toolCallId);
  const results = events.filter((event) => event.type === 'TOOL_CALL_RESULT');
  expect(results.map((event) => event.toolCallId)).toEqual(starts.map((event) => event.toolCallId));
  expect(new Set(results.map((event) => event.messageId)).size).toBe(results.length);
  for (const start of starts) {
    const messageStart = events.findIndex(
      (event) => event.type === 'TEXT_MESSAGE_START' && event.messageId === start.parentMessageId,
    );
    expect(messageStart).toBeGreaterThanOrEqual(0);
    expect(messageStart).toBeLessThan(events.indexOf(start));
    const alias = events.findIndex(
      (event) =>
        event.type === 'STATE_SNAPSHOT' &&
        Object.values(event.snapshot.messageIds).includes(start.parentMessageId),
    );
    const committedSnapshot = events.findIndex(
      (event) =>
        event.type === 'MESSAGES_SNAPSHOT' &&
        event.messages.some((message: any) => message.id === start.parentMessageId),
    );
    expect(alias).toBeGreaterThan(messageStart);
    expect(alias).toBeLessThan(committedSnapshot);
    const committed = events
      .filter((event) => event.type === 'MESSAGES_SNAPSHOT')
      .flatMap((event) => event.messages)
      .filter(
        (message: any) =>
          message.role === 'assistant' &&
          message.toolCalls?.some((call: any) => call.id === start.toolCallId),
      );
    expect(committed.length).toBeGreaterThan(0);
    expect(committed.every((message: any) => message.id === start.parentMessageId)).toBe(true);
    expect(
      events
        .filter((event) => event.type === 'MESSAGES_SNAPSHOT')
        .flatMap((event) => event.messages)
        .some((message: any) => message.role === 'tool' && message.toolCallId === start.toolCallId),
    ).toBe(true);
  }
  // A fresh attachment restores canonical history, without retaining a previous stream alias.
  const restored = await (await stub.observeRun(runId)).text();
  expect(restored).not.toContain('draft:');
  expect(restored).not.toContain('TOOL_CALL_RESULT');
});

it('streams reasoning before completion and restores it from committed history without signatures', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'slow reasoning_trace' });
  const reader = (await stub.observeRun(runId)).body!.getReader();
  const decoder = new TextDecoder();
  let body = '';
  while (!body.includes('REASONING_MESSAGE_CONTENT')) {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    body += decoder.decode(chunk.value, { stream: true });
  }
  expect(JSON.parse(await stub.snapshot()).pending).toHaveLength(1);
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += decoder.decode(chunk.value, { stream: true });
  }
  const events = body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
  expect(events.filter((e) => e.type === 'REASONING_MESSAGE_START')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'REASONING_MESSAGE_END')).toHaveLength(1);
  expect(
    events
      .filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join(''),
  ).toBe('核对来源，再比较结果。');
  const reasoningEnd = events.findIndex((e) => e.type === 'REASONING_MESSAGE_END');
  const reasoningStart = events.findIndex((e) => e.type === 'REASONING_MESSAGE_START');
  const messageStart = events.findIndex((e) => e.type === 'TEXT_MESSAGE_START');
  const reasoningContent = events.findIndex((e) => e.type === 'REASONING_MESSAGE_CONTENT');
  expect(reasoningStart).toBeLessThan(messageStart);
  expect(messageStart).toBeLessThan(reasoningContent);
  expect(reasoningEnd).toBeLessThan(events.findIndex((e) => e.type === 'TEXT_MESSAGE_CONTENT'));
  expect(events.at(-1).type).toBe('RUN_FINISHED');
  expect(await stub.snapshot()).not.toContain('fixture-private-signature');
  const { runInDurableObject } = await import('cloudflare:test');
  expect(
    await runInDurableObject(stub, async (instance) => JSON.stringify(await instance.allEntries())),
  ).toContain('fixture-private-signature');
  const reattached = await (await stub.observeRun(runId)).text();
  expect(reattached).toContain('"role":"reasoning"');
  expect(reattached).toContain('核对来源，再比较结果。');
  expect(body + reattached).not.toContain('fixture-private-signature');
});

it('replaces revised reasoning through a fresh prefix rather than concatenating incompatible text', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  const runId = crypto.randomUUID();
  await stub.submitRun({ runId, text: 'slow reasoning_trace reasoning_replacement' });
  const initial = await (await stub.observeRun(runId)).text();
  expect(initial).toContain('pi.reset');
  expect(initial).not.toContain('RUN_FINISHED');
  for (let i = 0; i < 150; i++) {
    if (!JSON.parse(await stub.snapshot()).pending.length) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const restored = await (await stub.observeRun(runId)).text();
  expect(restored).toContain('重新核对来源。');
  expect(restored).not.toContain('核对来源，再比较结果。');
  expect(restored).toContain('RUN_FINISHED');
});

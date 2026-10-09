import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
const chat = () => env.CONVERSATIONS.getByName(crypto.randomUUID());
const command = (text = 'hello') => ({ runId: crypto.randomUUID(), text });
it('deduplicates same request and rejects reused id with different content', async () => {
  const stub = chat(),
    c = command();
  const a = await stub.submitRun(c);
  expect(await stub.submitRun(c)).toEqual(a);
  expect(await stub.submitRun({ ...c, text: 'different' })).toMatchObject({
    error: { status: 409, code: 'request_conflict' },
  });
});
it('persists queued work and refuses the eleventh pending submission', async () => {
  const stub = chat();
  await stub.submitRun(command('slow'));
  for (let i = 0; i < 10; i++) await stub.submitRun(command('queued ' + i));
  expect(await stub.submitRun(command('overflow'))).toMatchObject({
    error: { status: 429, code: 'queue_full' },
  });
  await stub.stopConversation();
});
it('stop closes admission until an ignoring-cancellation tool actually settles', async () => {
  const stub = chat();
  await stub.submitRun(command('ignores_cancel'));
  for (let i = 0; i < 100; i++) {
    if (JSON.parse(await stub.snapshot()).tools?.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(JSON.parse(await stub.snapshot()).tools).toHaveLength(1);
  await stub.submitRun(command('later'));
  await stub.stopConversation();
  expect(JSON.parse(await stub.snapshot()).stopping).toBe(true);
  expect(await stub.submitRun(command())).toMatchObject({
    error: { status: 409, code: 'stopping' },
  });
  for (let i = 0; i < 100; i++) {
    if (!JSON.parse(await stub.snapshot()).stopping) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(JSON.parse(await stub.snapshot()).pending).toEqual([]);
});
it('continues after the accepting request returns without any observer', async () => {
  const stub = chat(),
    c = command('independent');
  await stub.submitRun(c);
  for (let i = 0; i < 100; i++) {
    const s = JSON.parse(await stub.snapshot());
    if (s.pending.length === 0) {
      expect(JSON.stringify(s.entries)).toContain('Answer: independent');
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Submitted work did not settle');
});
it('serializes a simultaneous stop and submit without losing the stop intent', async () => {
  const stub = chat();
  await stub.submitRun(command('slow'));
  const [, submission] = await Promise.all([
    stub.stopConversation(),
    stub.submitRun(command('racing')),
  ]);
  expect(submission).toMatchObject({ error: { code: 'stopping' } });
  for (let i = 0; i < 100; i++) {
    const s = JSON.parse(await stub.snapshot());
    if (!s.stopping) {
      expect(s.pending).toEqual([]);
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Stop did not finish');
});

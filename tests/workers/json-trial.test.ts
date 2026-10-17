import { env } from './env';
import { it, expect } from 'vitest';
it('accepts a structurally correct program case with reversed expected object keys', async () => {
  const stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'reordered_case' });
  for (let i = 0; i < 300; i++) {
    const snapshot = JSON.parse(await stub.snapshot());
    if (!snapshot.pending.length) {
      const results = snapshot.entries
        .flatMap((e: any) => e.model ?? [])
        .filter((m: any) => m.role === 'toolResult' && m.toolName === 'prepare_program');
      expect(results).toHaveLength(1);
      expect(results[0].isError).not.toBe(true);
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Trial did not settle');
});

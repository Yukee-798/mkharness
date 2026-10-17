import { abortAllDurableObjects } from 'cloudflare:test';
import { env } from './env';
import { it, expect } from 'vitest';
it('skill activation and resource reads survive SQLite-preserving reconstruction in ordinary Pi history', async () => {
  let stub = env.CONVERSATIONS.getByName(crypto.randomUUID());
  await stub.submitRun({ runId: crypto.randomUUID(), text: 'skill activation' });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (!JSON.parse(await stub.snapshot()).pending.length) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(ready).toBe(true);
  await abortAllDurableObjects();
  stub = env.CONVERSATIONS.get(stub.id);
  const snapshot = JSON.parse(await stub.snapshot());
  const results = snapshot.entries
    .flatMap((e: any) => e.model ?? [])
    .filter((m: any) => m.role === 'toolResult');
  expect(results.map((r: any) => r.toolName)).toEqual(['activate_skill', 'read_skill_resource']);
  expect(JSON.stringify(results)).toContain('Check dates');
});

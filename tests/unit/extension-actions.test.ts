import { expect, it } from 'vitest';
import { commandSchema } from '../../src/shared/contracts';
it('accepts finite extension actions and rejects unknown kinds and non-JSON payloads', () => {
  const request = {
    runId: crypto.randomUUID(),
    text: 'choose',
    source: {
      action: 'extension_action',
      extensionId: 'example',
      name: 'choose',
      payload: { selected: 'A' },
    },
  };
  expect(commandSchema.safeParse(request).success).toBe(true);
  expect(
    commandSchema.safeParse({
      ...request,
      source: { ...request.source, payload: { value: Infinity } },
    }).success,
  ).toBe(false);
  expect(
    commandSchema.safeParse({ ...request, source: { ...request.source, action: 'unknown' } })
      .success,
  ).toBe(false);
});

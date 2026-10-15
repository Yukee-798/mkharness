import { expect, it } from 'vitest';
import { remoteConfiguration, remoteExample } from '../../src/extensions/async-example/runtime';
it('async service configuration rejects ambiguous recovery and unbounded budgets before admission', () => {
  expect(() => remoteConfiguration({ ASYNC_SERVICE_URL: 'http://localhost' })).toThrow(
    'remote_configuration_invalid',
  );
  expect(() =>
    remoteConfiguration({ ASYNC_SERVICE_URL: 'https://service.example', ASYNC_RECOVERY: 'maybe' }),
  ).toThrow('remote_configuration_invalid');
  const host = {
    identity: 'chat',
    command: async () => ({ runId: crypto.randomUUID(), text: 'hi' }),
  };
  expect(() =>
    remoteExample(
      { endpoint: 'https://service.example', recovery: 'none', waitMs: Infinity },
      host,
    ),
  ).toThrow('remote_configuration_invalid');
});

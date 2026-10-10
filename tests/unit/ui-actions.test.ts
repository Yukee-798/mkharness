import { expect, it } from 'vitest';
import { commandSchema } from '../../src/shared/contracts';
import { externalURL } from '../../src/shared/ui-actions';

it('normalizes complete HTTP and HTTPS links without weakening the protocol boundary', () => {
  expect(externalURL('HTTPS://EXAMPLE.COM:443/watch?q=food#part')).toBe(
    'https://example.com/watch?q=food#part',
  );
  expect(externalURL('http://example.com/video/2')).toBe('http://example.com/video/2');
});

it.each([
  undefined,
  null,
  42,
  '',
  '/video/1',
  '//example.com',
  'https:example.com',
  'javascript:alert(1)',
  'data:text/html,hello',
  'file:///etc/passwd',
  'mailto:hello@example.com',
  'https://user:password@example.com',
  'https://user@example.com',
  ' https://example.com',
  'https://example.com\n/video',
  'https://example.com\u0000/video',
  'https://example.com\u007f/video',
  'https://example.com\\evil',
  'https://',
])('rejects unsafe or missing navigation targets: %j', (value) => {
  expect(() => externalURL(value)).toThrow();
});

it('accepts bounded JSON action context in a panel source and rejects unusable context', () => {
  const command = {
    runId: '3fac0a0b-18f2-4d54-b8cb-4a7e49d74ec9',
    text: 'Explain this choice',
    source: {
      panelRef: '2.call',
      action: 'continue_analysis',
      state: { $choice: 'B' },
      params: { context: 'Selected item: B', itemIndex: 1, details: { title: 'Video B' } },
    },
  };
  expect(commandSchema.parse(command).source).toEqual(command.source);
  for (const params of [
    { context: 'x'.repeat(16385) },
    { count: Infinity },
    { missing: undefined },
  ])
    expect(
      commandSchema.safeParse({ ...command, source: { ...command.source, params } }).success,
    ).toBe(false);
});

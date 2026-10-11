import { expect, it } from 'vitest';
import { externalURL, actionParams } from '../../src/extensions/openui/contracts';

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

it('accepts bounded finite action parameters and rejects unusable context', () => {
  expect(
    actionParams({ context: 'Selected item: B', itemIndex: 1, details: { title: 'Video B' } }),
  ).toEqual({ context: 'Selected item: B', itemIndex: 1, details: { title: 'Video B' } });
  for (const params of [
    { context: 'x'.repeat(16385) },
    { count: Infinity },
    { missing: undefined },
  ])
    expect(() => actionParams(params)).toThrow();
});

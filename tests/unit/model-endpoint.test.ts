import { afterEach, expect, it, vi } from 'vitest';
import { modelBaseUrl, modelEndpointFetch } from '../../src/server/models/endpoint';
afterEach(() => vi.restoreAllMocks());

it('normalizes a public HTTPS base path and rejects credential-bearing or private URLs', () => {
  expect(modelBaseUrl(' https://gateway.example.com/v1/ ')).toBe('https://gateway.example.com/v1');
  for (const url of [
    '',
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com?key=secret',
    'https://example.com#secret',
    'https://127.0.0.1',
    'https://2130706433',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://169.254.169.254',
    'https://100.64.1.2',
    'https://host.local',
    'https://localhost.',
    'https://private.internal',
    'https://foo.example.com/with space',
    'https://foo.example.com/' + 'x'.repeat(2048),
  ]) {
    expect(() => modelBaseUrl(url)).toThrow('Base URL');
  }
});

it('checks both DNS families before sending credentials and rejects mixed private answers', async () => {
  const dns = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://cloudflare-dns.com');
    return Response.json({
      Answer: [
        {
          type: url.searchParams.get('type') === 'A' ? 1 : 28,
          data: url.searchParams.get('type') === 'A' ? '93.184.216.34' : '::1',
        },
      ],
    });
  });
  const send = vi.fn();
  await expect(
    modelEndpointFetch('https://gateway.example.com/v1', send)(
      'https://gateway.example.com/v1/responses',
      { headers: { Authorization: 'Bearer CANARY' } },
    ),
  ).rejects.toThrow('public addresses');
  expect(dns).toHaveBeenCalledTimes(2);
  expect(send).not.toHaveBeenCalled();
});

it('limits credential delivery to the frozen origin and path and disallows redirects', async () => {
  const dns = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () =>
      Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] }),
    );
  const send = vi.fn(async () => Response.json({ ok: true }));
  const bound = modelEndpointFetch('https://gateway.example.com/v1', send);
  for (const destination of [
    'https://other.example.com/v1/responses',
    'https://gateway.example.com/other',
    'https://gateway.example.com/v10/responses',
    'http://gateway.example.com/v1/responses',
  ]) {
    await expect(bound(destination)).rejects.toThrow('escaped');
  }
  expect(dns).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  await bound('https://gateway.example.com/v1/responses', {
    redirect: 'follow',
    signal,
    headers: { Authorization: 'Bearer CANARY' },
  });
  expect(send).toHaveBeenCalledWith(
    'https://gateway.example.com/v1/responses',
    expect.objectContaining({
      redirect: 'error',
      signal,
      headers: { Authorization: 'Bearer CANARY' },
    }),
  );
});

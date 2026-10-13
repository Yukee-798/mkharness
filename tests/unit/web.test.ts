import { it, expect, vi } from 'vitest';
import { createWebReader, publicAddress, searchWeb, webTools } from '../../src/server/web';
const resolve = async () => ['93.184.216.34'];
it.each([undefined, '', '   ', '\t\n'])('omits search when its key is %j', (key) => {
  expect(webTools(key).tools?.map((tool) => tool.name)).toEqual(['read_web']);
});
it('registers search only with a non-empty key and retains the public page reader', () => {
  expect(webTools('  fixture-key  ').tools?.map((tool) => tool.name)).toEqual([
    'read_web',
    'search_web',
  ]);
});
it('rejects blank keys before network work and trims a configured key', async () => {
  const fetcher = vi.fn(async () => Response.json({ results: [] }));
  await expect(searchWeb('hello', ' \t\n', fetcher)).rejects.toThrow('not configured');
  expect(fetcher).not.toHaveBeenCalled();
  await expect(searchWeb('hello', '  fixture-key  ', fetcher)).resolves.toMatchObject({
    results: [],
  });
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.tavily.com/search',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fixture-key' }),
    }),
  );
});
it('rejects private, mapped, local, credential and non-web URLs before any request', async () => {
  const fetcher = vi.fn();
  const read = createWebReader({ fetcher, resolve });
  for (const url of [
    'file:///etc/passwd',
    'http://user:pass@example.com',
    'http://127.0.0.1',
    'http://2130706433',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'https://localhost',
    'http://169.254.169.254/latest',
    'http://10.0.0.1',
    'https://x.internal',
    'https://example.com:8443',
  ])
    await expect(read(url)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  expect(publicAddress('100.64.1.2')).toBe(false);
  await expect(
    createWebReader({ fetcher, resolve: async () => ['10.1.1.1'] })('https://private.example.com'),
  ).rejects.toThrow();
});
it('validates every redirect and preserves final source, title, truncated text and byte cap', async () => {
  const fetcher = vi.fn(async (url: any) =>
    url.toString().endsWith('/start')
      ? new Response(null, { status: 302, headers: { Location: '/end' } })
      : new Response(
          '<html><title>Example</title><script>hidden</script><p>' +
            'x'.repeat(70000) +
            '</p></html>',
          { headers: { 'Content-Type': 'text/html' } },
        ),
  );
  const result = await createWebReader({ fetcher, resolve })('https://example.com/start');
  expect(result.url).toBe('https://example.com/end');
  expect(result.title).toBe('Example');
  expect(result.truncated).toBe(true);
  expect(result.text).not.toContain('hidden');
  expect(new TextEncoder().encode(result.text).length).toBeLessThanOrEqual(65536);
  await expect(
    createWebReader({
      fetcher: async () =>
        new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1' } }),
      resolve,
    })('https://example.com'),
  ).rejects.toThrow();
  await expect(
    createWebReader({ fetcher: async () => new Response('x'.repeat(2097153)), resolve })(
      'https://example.com',
    ),
  ).rejects.toThrow('large');
});
it('times out the whole operation and reports unconfigured search without making a request', async () => {
  const fetcher = vi.fn(
    (_url: any, init: any) =>
      new Promise<Response>((_r, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      ),
  );
  await expect(
    createWebReader({ fetcher, resolve, timeoutMs: 20 })('https://example.com'),
  ).rejects.toThrow();
  await expect(searchWeb('hello', undefined, fetcher)).rejects.toThrow('not configured');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

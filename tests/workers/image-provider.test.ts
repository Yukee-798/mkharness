import { expect, it } from 'vitest';
import { kieImageProvider } from '../../src/extensions/images/kie';

it('uses a Workers-compatible request policy for submission and status reads', async () => {
  const requests: Request[] = [];
  const provider = kieImageProvider({
    key: 'fixture-key',
    fetcher: async (url, init) => {
      // Construct a real workerd Request: Node-only request mocks miss unsupported options.
      requests.push(new Request(url, init));
      return Response.json({
        code: 200,
        data: { taskId: 'job-1', state: 'generating' },
      });
    },
  });
  const signal = new AbortController().signal;
  expect(
    await provider.submit(
      { prompt: 'An orange robot', title: 'Robot', aspectRatio: '1:1', resolution: '1K' },
      signal,
    ),
  ).toBe('job-1');
  expect(await provider.inspect('job-1', signal)).toEqual({ status: 'pending' });
  expect(requests.map((request) => request.redirect)).toEqual(['manual', 'manual']);
});

it('rejects provider redirects without following them or forwarding credentials', async () => {
  let calls = 0;
  const provider = kieImageProvider({
    key: 'fixture-key',
    fetcher: async (url, init) => {
      calls++;
      new Request(url, init);
      return new Response(null, {
        status: 307,
        headers: { Location: 'https://another.example.test/collect' },
      });
    },
  });
  await expect(provider.inspect('job-1', new AbortController().signal)).rejects.toThrow(
    'image_provider_unavailable',
  );
  expect(calls).toBe(1);
});

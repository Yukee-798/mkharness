import { expect, it, vi } from 'vitest';
import { kieImageProvider, DEFAULT_KIE_IMAGE_MODEL } from '../../src/extensions/images/kie';
import { ImageProviderRejection } from '../../src/extensions/images/provider';
import { imageFiles } from '../../src/extensions/images/store';

const input = {
  title: 'Blue circle',
  prompt: 'A blue circle',
  aspectRatio: '1:1',
  resolution: '1K',
} as const;
it('maps the Kie wire contract and task results without leaking credentials into its public identity', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-key');
    return Response.json(
      requests.length === 1
        ? { code: 200, data: { taskId: 'job-1' } }
        : {
            code: 200,
            data: {
              taskId: 'job-1',
              state: 'success',
              resultJson: JSON.stringify({ resultUrls: ['https://cdn.example.test/image.png'] }),
            },
          },
    );
  });
  const provider = kieImageProvider({ key: 'fixture-key', fetcher });
  const signal = new AbortController().signal;
  expect(await provider.submit(input, signal)).toBe('job-1');
  expect(requests[0]).toEqual({
    url: 'https://api.kie.ai/api/v1/jobs/createTask',
    body: {
      model: DEFAULT_KIE_IMAGE_MODEL,
      input: { prompt: input.prompt, aspect_ratio: '1:1', resolution: '1K', background: 'opaque' },
    },
  });
  expect(await provider.inspect('job-1', signal)).toEqual({
    status: 'succeeded',
    urls: ['https://cdn.example.test/image.png'],
  });
  expect(requests[1]!.url).toBe('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=job-1');
  expect(provider.identity).not.toContain('fixture-key');
});
it('distinguishes definite rejection from an uncertain server failure and never retries POST', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 500 }));
  const provider = kieImageProvider({ key: 'fixture-key', fetcher });
  await expect(provider.submit(input, new AbortController().signal)).rejects.not.toBeInstanceOf(
    ImageProviderRejection,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  const rejected = kieImageProvider({
    key: 'fixture-key',
    fetcher: async () => Response.json({ code: 401 }),
  });
  await expect(rejected.submit(input, new AbortController().signal)).rejects.toBeInstanceOf(
    ImageProviderRejection,
  );
});
it('validates model restrictions before sending a paid request and rejects mismatched receipts', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      code: 200,
      data: {
        taskId: 'different',
        state: 'success',
        resultJson: '{"resultUrls":["https://cdn.example.test/image.png"]}',
      },
    }),
  );
  const provider = kieImageProvider({ key: 'fixture-key', fetcher });
  await expect(
    provider.submit(
      { ...input, resolution: '4K', aspectRatio: '27:16' },
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(ImageProviderRejection);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(provider.inspect('job-1', new AbortController().signal)).rejects.toThrow(
    'image_task_mismatch',
  );
});
it('rejects private result locations and non-image bytes before storing a file', async () => {
  const put = vi.fn(),
    fetcher = vi.fn(
      async () => new Response('<svg></svg>', { headers: { 'Content-Type': 'image/png' } }),
    );
  const bucket = { get: async () => null, put } as unknown as R2Bucket;
  const files = imageFiles(bucket, { fetcher, resolve: async () => ['93.184.216.34'] });
  await expect(
    files.save('images/fixture', ['https://127.0.0.1/private'], new AbortController().signal),
  ).rejects.toThrow('image_url_invalid');
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    files.save(
      'images/fixture',
      ['https://cdn.example.test/image.png'],
      new AbortController().signal,
    ),
  ).rejects.toThrow('image_format_unsupported');
  expect(put).not.toHaveBeenCalled();
  const redirect = imageFiles(bucket, {
    fetcher: async () =>
      new Response(null, { status: 302, headers: { Location: 'https://10.0.0.1/secret' } }),
    resolve: async () => ['93.184.216.34'],
  });
  await expect(
    redirect.save(
      'images/fixture',
      ['https://cdn.example.test/image.png'],
      new AbortController().signal,
    ),
  ).rejects.toThrow('image_url_invalid');
});

import { z } from 'zod';
import { boundedText } from '../../server/http/body';
import { imageRequest, type ImageRequest } from './contracts';
import { ImageProviderRejection, type ImageProvider, type ImageStatus } from './provider';

const envelope = z.object({ code: z.number(), data: z.unknown().optional() });
const taskId = z.string().min(1).max(512);
export const DEFAULT_KIE_IMAGE_MODEL = 'gpt-image-2-5-sunburst-text-to-image';
export function kieImageProvider({
  key,
  baseURL = 'https://api.kie.ai',
  model = DEFAULT_KIE_IMAGE_MODEL,
  fetcher = fetch,
}: {
  key: string;
  baseURL?: string;
  model?: string;
  fetcher?: typeof fetch;
}): ImageProvider {
  const endpoint = new URL(baseURL);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !key.trim() ||
    !model.trim()
  )
    throw new Error('Invalid Kie image configuration');
  const base = endpoint.href.replace(/\/$/, '');
  async function request(path: string, signal: AbortSignal, body?: unknown) {
    const response = await fetcher(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      // workerd supports manual/follow only. Reject 3xx below without forwarding credentials.
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 402, 403, 404, 422, 429].includes(response.status))
        throw new ImageProviderRejection('image_provider_rejected');
      throw new Error('image_provider_unavailable');
    }
    const value = envelope.parse(JSON.parse(await boundedText(response, 1048576)));
    if (value.code !== 200) {
      if ([400, 401, 402, 403, 404, 422, 429].includes(value.code))
        throw new ImageProviderRejection('image_provider_rejected');
      throw new Error('image_provider_unavailable');
    }
    return value.data;
  }
  return {
    identity: `kie:${base}:${model}`,
    async submit(raw: ImageRequest, signal) {
      const input = imageRequest.parse(raw);
      if (input.resolution !== '1K' && ['27:16', '16:27', '9:8', '8:9'].includes(input.aspectRatio))
        throw new ImageProviderRejection('image_parameters_invalid');
      const result = await request('/api/v1/jobs/createTask', signal, {
        model,
        input: {
          prompt: input.prompt,
          aspect_ratio: input.aspectRatio,
          resolution: input.resolution,
          background: 'opaque',
        },
      });
      return z.object({ taskId }).parse(result).taskId;
    },
    async inspect(id, signal): Promise<ImageStatus> {
      const result = z
        .object({ taskId, state: z.string(), resultJson: z.string().nullable().optional() })
        .parse(
          await request(
            '/api/v1/jobs/recordInfo?taskId=' + encodeURIComponent(taskId.parse(id)),
            signal,
          ),
        );
      if (result.taskId !== id) throw new Error('image_task_mismatch');
      if (result.state === 'fail') return { status: 'failed', code: 'image_generation_failed' };
      if (result.state === 'success') {
        const value = z
          .object({ resultUrls: z.array(z.string().url()).min(1).max(4) })
          .parse(JSON.parse(result.resultJson ?? 'null'));
        return { status: 'succeeded', urls: value.resultUrls };
      }
      if (!['waiting', 'queuing', 'generating'].includes(result.state))
        throw new Error('image_status_invalid');
      return { status: 'pending' };
    },
  };
}

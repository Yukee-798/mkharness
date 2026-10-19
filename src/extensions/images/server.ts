import type {
  ContributionHost,
  ReadContext,
  ServerContribution,
} from '../../server/extensions/contributions';
import { AppError } from '../../shared/contracts';
import { imageResult } from './contracts';
import { imageGeneration, pruneImageOperations, createImageTask } from './runtime';
import { kieImageProvider } from './kie';
import { imageFiles, type ImageFiles } from './store';
import type { ImageProvider } from './provider';

export function configuredImages(env: Record<string, unknown>, host?: ContributionHost) {
  const files = env.ARTIFACT_FILES ? imageFiles(env.ARTIFACT_FILES as R2Bucket) : undefined;
  const key = typeof env.KIE_API_KEY === 'string' ? env.KIE_API_KEY.trim() : '';
  const provider = key
    ? kieImageProvider({
        key,
        ...(typeof env.KIE_BASE_URL === 'string' && env.KIE_BASE_URL
          ? { baseURL: env.KIE_BASE_URL }
          : {}),
        ...(typeof env.KIE_IMAGE_MODEL === 'string' && env.KIE_IMAGE_MODEL
          ? { model: env.KIE_IMAGE_MODEL }
          : {}),
      })
    : undefined;
  return imagesContribution({ files, provider }, host);
}
/** Replace the provider at this seam; storage, history and browser presentation stay the same. */
export function imagesContribution(
  {
    provider,
    files,
    pollMs,
    waitMs,
  }: {
    provider?: ImageProvider;
    files?: ImageFiles;
    pollMs?: number;
    waitMs?: number;
  },
  host?: ContributionHost,
): ServerContribution {
  if (provider && (!files || !host)) throw new AppError(503, 'image_configuration_invalid');
  const receipt = async (ref: string, context: ReadContext) => {
    const result = await context.successfulTool(ref, 'generate_image');
    if (!result || !files) throw new AppError(404, 'resource_not_found');
    const metadata = imageResult.safeParse(result.details);
    if (
      !metadata.success ||
      metadata.data.ref !== ref ||
      typeof result.details.prefix !== 'string' ||
      !result.details.prefix.startsWith('images/')
    )
      throw new AppError(404, 'resource_not_found');
    return { ...metadata.data, prefix: result.details.prefix };
  };
  const task = provider && files ? createImageTask(provider, files, { pollMs, waitMs }) : undefined;
  const native =
    provider && files && host
      ? imageGeneration(provider, files, host, { pollMs, waitMs }, task)
      : undefined;
  const extension =
    native && host?.scenario?.kind === 'canvas' ? { ...native, tools: [], sections: [] } : native;
  return {
    id: 'images',
    ...(task && provider ? { imageJobs: { task, provider: provider.identity } } : {}),
    execution: { beforeSubmit: pruneImageOperations },
    ...(extension ? { extension } : {}),
    resources: {
      async read(ref, context) {
        const { prefix: _prefix, ...data } = await receipt(ref, context);
        return { data, initialState: {} };
      },
      async readFile(ref, name, context) {
        const data = await receipt(ref, context);
        if (!data.images.some((image) => image.file === name))
          throw new AppError(404, 'resource_not_found');
        try {
          return await files!.read(data.prefix, name);
        } catch {
          throw new AppError(404, 'resource_not_found');
        }
      },
    },
  };
}

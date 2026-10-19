import { z } from 'zod';

export const imageRequest = z.object({
  prompt: z.string().trim().min(1).max(20000),
  title: z.string().trim().min(1).max(100),
  aspectRatio: z.enum([
    'auto',
    '1:1',
    '3:2',
    '2:3',
    '4:3',
    '3:4',
    '16:9',
    '9:16',
    '21:9',
    '27:16',
    '16:27',
    '9:8',
    '8:9',
  ]),
  resolution: z.enum(['1K', '2K', '4K']),
});
export type ImageRequest = z.infer<typeof imageRequest>;
export const imageAsset = z.object({
  file: z.string().regex(/^image-[1-4]\.(png|jpg|webp)$/),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  bytes: z
    .number()
    .int()
    .positive()
    .max(32 * 1048576),
});
export const imageResult = z.object({
  ref: z.string().min(1).max(512),
  title: z.string().min(1).max(100),
  images: z.array(imageAsset).min(1).max(4),
});
export type ImageAsset = z.infer<typeof imageAsset>;
export type ImageResult = z.infer<typeof imageResult>;
export function imageFileURL(
  chatId: string,
  ref: string,
  file: string,
  download = false,
  target?: number,
) {
  const query = new URLSearchParams();
  if (download) query.set('download', '1');
  if (target) query.set('conversationId', String(target));
  return `/api/conversations/${encodeURIComponent(chatId)}/extensions/images/resources/${encodeURIComponent(ref)}/files/${encodeURIComponent(file)}${query.size ? '?' + query : ''}`;
}

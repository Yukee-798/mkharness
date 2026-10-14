import { z } from 'zod';

// Keep inline images bounded so a complete immutable submission fits the existing
// request budget. Pi owns the durable bytes; no public upload URL is created.
export const imageModelError = '所选模型不支持图片，请选择支持图片的模型';
export const IMAGE_LIMITS = { count: 4, bytes: 512 * 1024 } as const;
export const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export function matchesImageType(bytes: Uint8Array, mimeType: string): boolean {
  const prefix = (...values: number[]) => values.every((v, i) => bytes[i] === v);
  if (mimeType === 'image/png') return prefix(137, 80, 78, 71, 13, 10, 26, 10);
  if (mimeType === 'image/jpeg') return prefix(255, 216, 255);
  if (mimeType === 'image/gif')
    return prefix(71, 73, 70, 56) && [55, 57].includes(bytes[4]!) && bytes[5] === 97;
  return (
    mimeType === 'image/webp' &&
    prefix(82, 73, 70, 70) &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  );
}
export const imageSchema = z
  .object({
    name: z.string().min(1).max(200),
    mimeType: z.enum(imageTypes),
    data: z
      .string()
      .min(4)
      .max(Math.ceil(IMAGE_LIMITS.bytes / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()
  .refine((image) => {
    try {
      const binary = atob(image.data);
      return (
        binary.length <= IMAGE_LIMITS.bytes &&
        btoa(binary) === image.data &&
        matchesImageType(
          Uint8Array.from(binary.slice(0, 12), (c) => c.charCodeAt(0)),
          image.mimeType,
        )
      );
    } catch {
      return false;
    }
  }, '仅支持有效的 PNG、JPEG、WebP 或 GIF 图片');
export type ImageAttachment = z.infer<typeof imageSchema>;
export const imagesSchema = z
  .array(imageSchema)
  .min(1)
  .max(IMAGE_LIMITS.count)
  .refine(
    (images) =>
      images.reduce(
        (size, image) =>
          size +
          (image.data.length * 3) / 4 -
          (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0),
        0,
      ) <= IMAGE_LIMITS.bytes,
    '图片总大小不能超过 512 KiB',
  );
export function userContent(text: string, images?: readonly ImageAttachment[]) {
  return images?.length
    ? [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })),
      ]
    : text;
}
export function browserUserContent(
  text: string,
  images?: readonly { data: string; mimeType: string; name: string }[],
) {
  return images?.length
    ? [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...images.map(({ data, mimeType, name }) => ({
          type: 'image' as const,
          source: { type: 'data' as const, value: data, mimeType },
          metadata: { filename: name },
        })),
      ]
    : text;
}

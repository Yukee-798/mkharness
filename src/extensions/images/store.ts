import { isIP } from 'node:net';
import { publicAddress, resolvePublicAddresses } from '../../server/http/public-network';
import { matchesImageType } from '../../shared/images';
import { imageAsset, type ImageAsset } from './contracts';
import { z } from 'zod';

const manifest = z.array(imageAsset).min(1).max(4);
const MAX_BYTES = 32 * 1048576;
export type ImageFiles = {
  saved(prefix: string): Promise<ImageAsset[] | null>;
  save(prefix: string, urls: readonly string[], signal: AbortSignal): Promise<ImageAsset[]>;
  read(
    prefix: string,
    file: string,
  ): Promise<{ body: ReadableStream; contentType: string; filename: string; size: number }>;
};
/** Materializes temporary provider URLs once; reads use only committed private object references. */
export function imageFiles(
  bucket: R2Bucket,
  {
    fetcher = fetch,
    resolve = resolvePublicAddresses,
  }: {
    fetcher?: typeof fetch;
    resolve?: typeof resolvePublicAddresses;
  } = {},
): ImageFiles {
  async function download(raw: string, signal: AbortSignal) {
    let url = new URL(raw);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        /(^|\.)(localhost|local|internal|home|lan)$/.test(host)
      )
        throw new Error('image_url_invalid');
      const addresses = isIP(host) ? [host] : await resolve(host, deadline, fetcher);
      if (!addresses.length || addresses.some((ip) => !publicAddress(ip)))
        throw new Error('image_url_invalid');
      const response = await fetcher(url, { signal: deadline, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('Location');
        await response.body?.cancel();
        if (!location) throw new Error('image_download_failed');
        url = new URL(location, url);
        continue;
      }
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get('Content-Length')) > MAX_BYTES
      ) {
        await response.body?.cancel();
        throw new Error('image_download_failed');
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) {
            await reader.cancel();
            throw new Error('image_too_large');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      for (const [contentType, extension] of [
        ['image/png', 'png'],
        ['image/jpeg', 'jpg'],
        ['image/webp', 'webp'],
      ] as const)
        if (matchesImageType(bytes, contentType)) return { bytes, contentType, extension };
      throw new Error('image_format_unsupported');
    }
    throw new Error('image_download_failed');
  }
  const store: ImageFiles = {
    async saved(prefix) {
      const object = await bucket.get(prefix + '/manifest.json');
      return object ? manifest.parse(await object.json()) : null;
    },
    async save(prefix, urls, signal) {
      const existing = await store.saved(prefix);
      if (existing) return existing;
      if (!urls.length || urls.length > 4) throw new Error('image_result_invalid');
      const assets: ImageAsset[] = [];
      for (const [index, url] of urls.entries()) {
        signal.throwIfAborted();
        const { bytes, contentType, extension } = await download(url, signal);
        const file = `image-${index + 1}.${extension}`;
        await bucket.put(prefix + '/' + file, bytes, { httpMetadata: { contentType } });
        assets.push(imageAsset.parse({ file, mediaType: contentType, bytes: bytes.length }));
      }
      signal.throwIfAborted();
      await bucket.put(prefix + '/manifest.json', JSON.stringify(assets), {
        httpMetadata: { contentType: 'application/json' },
      });
      return assets;
    },
    async read(prefix, file) {
      const asset = (await store.saved(prefix))?.find((item) => item.file === file);
      if (!asset) throw new Error('image_file_not_found');
      const object = await bucket.get(prefix + '/' + asset.file);
      if (!object) throw new Error('image_file_not_found');
      return {
        body: object.body,
        contentType: asset.mediaType,
        filename: asset.file,
        size: object.size,
      };
    },
  };
  return store;
}

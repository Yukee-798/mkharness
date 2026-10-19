import type { ImageRequest } from './contracts';

export type ImageStatus =
  | { status: 'pending' }
  | { status: 'failed'; code: string }
  | { status: 'succeeded'; urls: string[] };

/** The provider owns wire formats and credentials; Pi owns waiting and recovery. */
export interface ImageProvider {
  /** Credential-free configuration identity; changing providers must not resume an old job. */
  readonly identity: string;
  submit(request: ImageRequest, signal: AbortSignal): Promise<string>;
  inspect(id: string, signal: AbortSignal): Promise<ImageStatus>;
}
/** A definitive rejection differs from a lost submission receipt. */
export class ImageProviderRejection extends Error {}

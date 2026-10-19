import { canvasManifest } from './manifest';
import type { BrowserExtension } from '../../browser/extensions/extensions';
export const toolkit = {} satisfies BrowserExtension['toolkit'];

export const pack = { id: canvasManifest.id, version: canvasManifest.version };

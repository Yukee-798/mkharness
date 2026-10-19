import { reportsManifest } from './manifest';
import type { BrowserExtension } from '../../browser/extensions/extensions';
/** The report card uses the shared workspace tool renderer; the view loads lazily. */
export const toolkit = {} satisfies BrowserExtension['toolkit'];

export const pack = { id: reportsManifest.id, version: reportsManifest.version };

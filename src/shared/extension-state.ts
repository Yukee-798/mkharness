import type { Json } from './compute';

/** Only explicitly projected extension data is public; native records stay server-side. */
export type ExtensionState = Record<string, Json>;

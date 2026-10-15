import type { Json } from './json';

/** Only explicitly projected extension data is public; native records stay server-side. */
export type ExtensionState = Record<string, Json>;

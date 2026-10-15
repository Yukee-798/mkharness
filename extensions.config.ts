import type { ExtensionConfiguration } from './src/extensions/configuration';

/** Reviewed deployment configuration. Connection URLs and secrets stay in server bindings. */
export default {
  timing: { enabled: true },
  web: { enabled: true },
  openui: { enabled: true, inspect: false },
  reply: { enabled: true },
  'async-example': { enabled: true },
  mcp: { enabled: true, custom: true },
  example: { enabled: false },
  skills: { enabled: true },
  'skills-example': { enabled: false },
} satisfies ExtensionConfiguration;

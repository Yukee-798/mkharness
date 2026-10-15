import configuration from '../../extensions.config';
import { AppError } from '../shared/contracts';

export type ExtensionConfiguration = Readonly<
  Record<
    string,
    {
      readonly enabled: boolean;
      readonly [option: string]: unknown;
    }
  >
>;

export { configuration as extensionConfiguration };
export function extensionEnabled(id: string, config: ExtensionConfiguration = configuration) {
  return config[id]?.enabled === true;
}

export function validateConfiguration(
  config: ExtensionConfiguration,
  registeredIds: readonly string[],
) {
  const known = new Set([...registeredIds, 'mcp']);
  for (const [id, setting] of Object.entries(config)) {
    if (!known.has(id)) throw new AppError(503, 'unknown_extension_configuration');
    if (!setting || typeof setting.enabled !== 'boolean')
      throw new AppError(503, 'invalid_extension_configuration');
  }
}

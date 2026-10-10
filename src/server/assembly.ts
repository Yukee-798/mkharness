import type { Extension, EntryRecord } from '@earendil-works/pi-durable';
import { panelTools } from './panel-tools';
import { webTools } from './web';
import { runLimits, uiInstructions } from './limits';
import { exampleExtension } from './extensions';

/** Developer-owned composition point. Return native Pi extensions; do not download executable code. */
export async function applicationExtensions(
  env: Env,
  entries: () => Promise<readonly EntryRecord[]>,
): Promise<Extension[]> {
  const config = env as Env & {
    ENABLE_GENERATIVE_UI?: string;
    ENABLE_EXAMPLE_EXTENSION?: string;
    TAVILY_API_KEY?: string;
  };
  return [
    runLimits(entries),
    webTools(config.TAVILY_API_KEY),
    ...(config.ENABLE_GENERATIVE_UI === '0' ? [] : [panelTools(entries), uiInstructions(entries)]),
    ...(config.ENABLE_EXAMPLE_EXTENSION === '1' ? [exampleExtension()] : []),
  ];
}

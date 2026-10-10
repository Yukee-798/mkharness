import type { Extension, EntryRecord } from '@earendil-works/pi-durable';
import { panelTools } from './panel-tools';
import { webTools } from './web';
import { runLimits, uiInstructions, toolBudget } from './limits';
import { staticSkills, exampleSkillSource } from './skills';
import { exampleExtension } from './extensions';

/** Developer-owned composition point. Return native Pi extensions; do not download executable code. */
export async function applicationExtensions(
  env: Env,
  entries: () => Promise<readonly EntryRecord[]>,
): Promise<Extension[]> {
  const config = env as Env & {
    ENABLE_GENERATIVE_UI?: string;
    ENABLE_EXAMPLE_EXTENSION?: string;
    ENABLE_EXAMPLE_SKILL?: string;
    TAVILY_API_KEY?: string;
  };
  return [
    ...(config.ENABLE_EXAMPLE_SKILL === '1' ? [await staticSkills([exampleSkillSource()])] : []),
    runLimits(entries, toolBudget(env as unknown as Record<string, unknown>)),
    webTools(config.TAVILY_API_KEY),
    ...(config.ENABLE_GENERATIVE_UI === '0' ? [] : [panelTools(entries), uiInstructions(entries)]),
    ...(config.ENABLE_EXAMPLE_EXTENSION === '1' ? [exampleExtension()] : []),
  ];
}

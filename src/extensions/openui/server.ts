import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ServerContribution } from '../../server/contributions';
import { panelTools } from '../../server/panel-tools';
import { uiInstructions } from '../../server/limits';
export function openuiContribution(
  entries: () => Promise<readonly EntryRecord[]>,
): ServerContribution {
  const tools = panelTools(entries),
    instructions = uiInstructions(entries);
  return {
    id: 'openui',
    extension: {
      ...tools,
      name: 'openui',
      sections: instructions.sections,
      hooks: instructions.hooks,
    },
  };
}

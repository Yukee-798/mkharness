import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ServerContribution } from '../../server/contributions';
import { panelTools } from '../../server/panel-tools';
import { uiInstructions } from '../../server/limits';
import { AppError } from '../../shared/contracts';
import { finiteJson } from '../../shared/compute';
import { successfulTool } from '../../shared/references';
import { validateUI } from '../../server/panel-tools';
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
    resources: {
      async read(ref, context) {
        const history = await context.entries();
        const panel = successfulTool(history, ref, 'present_openui');
        if (!panel) throw new AppError(404, 'resource_not_found');
        const programRef = panel.args.programRef;
        const program =
          typeof programRef === 'string'
            ? successfulTool(history, programRef, 'prepare_program')
            : undefined;
        if (programRef && !program) throw new AppError(409, 'program_not_recoverable');
        const initialState = (await validateUI(String(panel.args.ui), !!program)).stateDeclarations;
        finiteJson(initialState);
        return {
          data: {
            ui: String(panel.args.ui),
            program: program
              ? {
                  code: String(program.args.code),
                  data: program.args.data as import('../../shared/compute').Json,
                }
              : null,
          },
          initialState,
        };
      },
      validateState(state) {
        if (!state || typeof state !== 'object' || Array.isArray(state))
          throw new AppError(400, 'invalid_state');
        finiteJson(state);
        return state;
      },
    },
  };
}

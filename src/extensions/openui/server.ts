import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ServerContribution } from '../../server/extensions/contributions';
import { panelTools } from './tools';
import { uiInstructions } from './instructions';
import { AppError } from '../../shared/contracts';
import { finiteJson } from '../../shared/json';
import { validateUI } from './tools';
import { actionParams } from './contracts';
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
      sections: [...(tools.sections ?? []), ...(instructions.sections ?? [])],
      hooks: instructions.hooks,
    },
    resources: {
      async read(ref, context) {
        const panel = await context.successfulTool(ref, 'present_openui');
        if (!panel) throw new AppError(404, 'resource_not_found');
        const programRef = panel.args.programRef;
        const program =
          typeof programRef === 'string'
            ? await context.successfulTool(programRef, 'prepare_program')
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
                  data: program.args.data as import('../../shared/json').Json,
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
    actions: {
      continue: {
        async normalize(payload, context) {
          if (
            !payload ||
            typeof payload !== 'object' ||
            Array.isArray(payload) ||
            typeof payload.ref !== 'string'
          )
            throw new AppError(400, 'invalid_action_payload');
          if (!(await context.successfulTool(payload.ref, 'present_openui')))
            throw new AppError(404, 'resource_not_found');
          const state = payload.state;
          if (!state || typeof state !== 'object' || Array.isArray(state))
            throw new AppError(400, 'invalid_action_payload');
          finiteJson(state);
          let params;
          try {
            params = actionParams(payload.params ?? {});
          } catch {
            throw new AppError(400, 'invalid_action_payload');
          }
          return { inputs: state, ...(Object.keys(params).length ? { params } : {}) };
        },
      },
    },
  };
}

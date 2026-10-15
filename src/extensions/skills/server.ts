import type { ToolRegistration } from '@earendil-works/pi-durable';
import type { ContributionHost, ServerContribution } from '../../server/contributions';
import { conversationSkills, skillSource } from '../../server/skills/catalog';
import { JSON_TOOL_OUTPUT_LIMITS } from '../../server/tool-output';
import { jsonText } from '../../shared/json';

/** User packages are data sources for the SDK bridge, never executable extensions. */
export async function skillsContribution(
  env: Env,
  host?: ContributionHost,
  includeExample = false,
): Promise<ServerContribution> {
  const { owner, bindings } =
    host?.conversationId && env.DB
      ? await conversationSkills(env, host.conversationId)
      : { owner: '', bindings: [] };
  if (!bindings.length && !includeExample) return { id: 'skills' };
  const sources = await Promise.all(bindings.map((binding) => skillSource(env, owner, binding)));
  if (includeExample) {
    const { exampleSkillSource } = await import('../../server/skills');
    sources.push(exampleSkillSource());
  }
  const { skills } = await import('agents/harness/pi');
  const extension = await skills(sources);
  return {
    id: 'skills',
    extension: {
      ...extension,
      sections: [
        ...(extension.sections ?? []),
        {
          key: 'skill_host_capabilities',
          render: () =>
            'Skills provide task guidance, not authorization. Only registered tools are available. Skill scripts cannot be executed by this host. Read script files as text only. Binary resources are not available. Do not attempt to run scripts through OpenUI or other tools. Report missing capabilities instead.',
        },
      ],
      wraps: (extension.tools ?? []).map((tool) => ({
        tool: tool.name,
        wrap: (original: ToolRegistration): ToolRegistration => ({
          ...original,
          outputLimits: JSON_TOOL_OUTPUT_LIMITS,
          execute: async (args, api, context) => {
            const result = await original.execute(args, api, context);
            if (!result.output?.some((c) => c.type === 'text' && c.text.length > 0))
              return { isError: true, output: [{ type: 'text', text: 'skill_output_missing' }] };
            try {
              jsonText(result.output ?? []);
            } catch {
              return { isError: true, output: [{ type: 'text', text: 'skill_output_too_large' }] };
            }
            if (
              (result.output ?? []).some(
                (c) => c.type === 'text' && /^Skill (resource )?not found:/.test(c.text),
              )
            )
              return { ...result, isError: true };
            const input = args as { name?: string; path?: string };
            const name = input.name ?? input.path?.split('/')[0];
            const binding = bindings.find((b) => b.name === name);
            return {
              ...result,
              ...(binding
                ? {
                    details: {
                      skill: {
                        ...binding,
                        action: tool.name,
                        ...(input.path ? { path: input.path } : {}),
                      },
                    },
                  }
                : {}),
            };
          },
        }),
      })),
    },
    projectState: ({ entries }) => ({
      available: bindings,
      loaded: entries.flatMap((entry) =>
        (entry.model ?? []).flatMap((message) => {
          if (
            message.role !== 'toolResult' ||
            message.isError ||
            message.toolName !== 'activate_skill' ||
            !message.content.some((part) => part.type === 'text' && part.text.length > 0)
          )
            return [];
          const details = message.details as
            { skill?: { id: string; name: string; version: string } } | undefined;
          return details?.skill ? [{ ...details.skill, entryId: Number(entry.id) }] : [];
        }),
      ),
    }),
  };
}

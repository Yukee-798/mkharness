import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ContributionHost, ServerContribution } from '../../server/extensions/contributions';
import { skillSource } from '../../server/skills/catalog';
import { nativeSkills } from '../../server/skills/native';

/** User packages are data sources for native Pi, never executable extensions. */
export async function skillsContribution(
  env: Env,
  host?: ContributionHost,
  includeExample = false,
): Promise<ServerContribution> {
  const owner = host?.ownerId ?? '',
    bindings = host?.skillBindings ?? [];
  if (!bindings.length && !includeExample) return { id: 'skills' };
  const sources = await Promise.all(bindings.map((binding) => skillSource(env, owner, binding)));
  if (includeExample) {
    const { exampleSkillSource } = await import('./example');
    sources.push(exampleSkillSource());
  }
  const extension = await nativeSkills(sources);
  return {
    id: 'skills',
    projectConversation: () => ({ available: bindings }),
    projectHistory: ({ entries }) =>
      Object.fromEntries(
        loadedSkills(entries).map((skill) => [String(skill.entryId), { loaded: [skill] }]),
      ),
    extension,
  };
}

function loadedSkills(entries: readonly EntryRecord[]) {
  return entries.flatMap((entry) =>
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
  );
}

import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { useExtensionContext } from '../../browser/extension-context';
import type { ExtensionUI } from '../../browser/extensions';
import type { SkillBinding } from '../../shared/skills';
type State = { available: SkillBinding[] };
function SkillMeta({ part }: { part: ToolCallMessagePartProps }) {
  const { state } = useExtensionContext();
  if (!['activate_skill', 'read_skill_resource'].includes(part.toolName)) return null;
  const args = part.args as { name?: string; path?: string };
  const skill = (state?.skills as State | undefined)?.available.find(
    (s) => s.name === (args.name ?? args.path?.split('/')[0]),
  );
  return skill ? (
    <span className="text-xs text-muted-foreground">
      {skill.name} · {skill.version.slice(0, 8)}
    </span>
  ) : null;
}
export const ui: ExtensionUI = { toolTitleMeta: SkillMeta };

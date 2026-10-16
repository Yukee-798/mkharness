import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';
import { skillQuery } from './queries';
import { useLocale } from '../../browser/app/locale';
import { Button } from '../../browser/ui/button';
import { Checkbox } from '../../browser/ui/checkbox';
import { Label } from '../../browser/ui/label';
import { Alert, AlertDescription } from '../../browser/ui/alert';
import { Popover, PopoverContent, PopoverTrigger } from '../../browser/ui/popover';
import { SKILL_LIMITS } from '../../shared/skills';
import type { SkillView } from '../../shared/skills';

export function useSkillSelection(userId: string, enabled: boolean) {
  const query = useQuery({ ...skillQuery(userId), enabled });
  const [selected, setSelected] = useState<string[]>();
  const available = query.data?.skills.filter((s) => s.enabled) ?? [];
  const ids =
    selected?.filter((id) => available.some((s) => s.id === id)) ?? available.map((s) => s.id);
  // A failed background refresh must not replace an explicit selection with account defaults.
  const creationIds = query.data ? ids : selected;
  return { query, available, ids, creationIds, setSelected };
}
export function SkillPicker({
  available,
  ids,
  onChange,
  disabled,
  failed,
  loading,
}: {
  available: SkillView[];
  ids: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  failed: boolean;
  loading: boolean;
}) {
  const { t } = useLocale();
  if (loading || (!available.length && !failed)) return null;
  return (
    <div className="mb-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            className="text-xs text-muted-foreground"
          >
            <BookOpen />
            {t('Skills')} · {ids.length}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-80 space-y-3 overflow-y-auto">
          <p className="text-sm font-medium">{t('Skills for this chat')}</p>
          <p className="text-xs text-muted-foreground">
            {t(
              'The agent loads selected skills when relevant. Versions are fixed when this chat starts.',
            )}
          </p>
          {failed && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">
                {t(
                  'Could not refresh skills. Existing selections are kept; otherwise account defaults apply.',
                )}
              </AlertDescription>
            </Alert>
          )}
          {ids.length > SKILL_LIMITS.selected && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">
                {t('Select at most 8 skills.')}
              </AlertDescription>
            </Alert>
          )}
          {available.map((s) => (
            <Label key={s.id} className="items-start font-normal leading-normal">
              <Checkbox
                checked={ids.includes(s.id)}
                disabled={disabled || (!ids.includes(s.id) && ids.length >= SKILL_LIMITS.selected)}
                onCheckedChange={(checked) =>
                  onChange(checked ? [...ids, s.id] : ids.filter((id) => id !== s.id))
                }
              />
              <span className="min-w-0">
                <span className="break-words">{s.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{s.description}</span>
              </span>
            </Label>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

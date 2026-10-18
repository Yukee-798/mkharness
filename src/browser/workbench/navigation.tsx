import { Clock3, MessageSquare, Puzzle } from 'lucide-react';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useLocale } from '../app/locale';
export type WorkbenchView = 'agent' | 'schedules' | 'plugins';
export function WorkbenchNavigation({
  view,
  collapsed,
  onChange,
}: {
  view: WorkbenchView;
  collapsed: boolean;
  onChange: (view: WorkbenchView) => void;
}) {
  const { t } = useLocale();
  return (
    <nav aria-label={t('工作台导航')} className="grid shrink-0 gap-1 border-b p-2">
      {(
        [
          ['agent', 'Agent', MessageSquare],
          ['schedules', '定时任务', Clock3],
          ['plugins', '插件市场', Puzzle],
        ] as const
      ).map(([key, title, Icon]) => (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              className={
                collapsed
                  ? 'justify-center px-0 aria-[current=page]:bg-accent'
                  : 'justify-start gap-3 aria-[current=page]:bg-accent'
              }
              aria-label={t(title)}
              aria-current={view === key ? 'page' : undefined}
              onClick={() => onChange(key)}
            >
              <Icon className="size-4 shrink-0" />
              <span className={collapsed ? 'sr-only' : undefined}>{t(title)}</span>
            </Button>
          </TooltipTrigger>
          {collapsed && <TooltipContent side="right">{t(title)}</TooltipContent>}
        </Tooltip>
      ))}
    </nav>
  );
}
export function WorkbenchPlaceholder({ view }: { view: Exclude<WorkbenchView, 'agent'> }) {
  const { t } = useLocale();
  const Icon = view === 'schedules' ? Clock3 : Puzzle;
  return (
    <div className="m-auto flex flex-col items-center gap-3 p-8 text-center">
      <Icon className="size-7 text-muted-foreground" />
      <h1 className="text-xl font-medium">{t(view === 'schedules' ? '定时任务' : '插件市场')}</h1>
      <p className="text-sm text-muted-foreground">{t('即将开放')}</p>
    </div>
  );
}

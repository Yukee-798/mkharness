import { useLocale } from './locale';
import { useEffect, useState, type ReactNode } from 'react';
import { MessageSquare, PanelLeft, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../ui/utils';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from '../ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

export function AppShell({
  children,
  directory,
  footer,
  title,
  menu,
  onMenuChange,
  onNewChat,
  creating = false,
}: {
  children: ReactNode;
  directory?: ReactNode;
  footer: (collapsed: boolean) => ReactNode;
  title?: string;
  menu: boolean;
  onMenuChange: (open: boolean) => void;
  onNewChat?: () => void;
  creating?: boolean;
}) {
  const { t } = useLocale();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('agent-ui.sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('agent-ui.sidebar-collapsed', String(collapsed));
    } catch {
      /* The layout remains usable when browser storage is unavailable. */
    }
  }, [collapsed]);
  useEffect(() => {
    const desktop = matchMedia('(min-width: 768px)');
    const closeDrawer = () => {
      if (desktop.matches) onMenuChange(false);
    };
    closeDrawer();
    desktop.addEventListener('change', closeDrawer);
    return () => desktop.removeEventListener('change', closeDrawer);
  }, [onMenuChange]);
  const toggleLabel = collapsed ? t('展开侧栏') : t('收起侧栏');
  const content = directory ?? (
    <div className="flex h-full flex-col gap-5 p-4">
      <Button variant="outline" className="w-full justify-start" disabled>
        <Plus />
        {t('新建聊天')}
      </Button>
      <p className="px-2 text-sm text-muted-foreground">{t('登录后，在这里继续你的聊天。')}</p>
    </div>
  );
  return (
    <TooltipProvider delayDuration={200}>
      <Sheet open={menu} onOpenChange={onMenuChange}>
        <div
          className={cn(
            'grid h-dvh grid-cols-1 overflow-hidden',
            collapsed
              ? 'md:grid-cols-[3.5rem_minmax(0,1fr)]'
              : 'md:grid-cols-[16rem_minmax(0,1fr)]',
          )}
        >
          <a
            className="sr-only z-50 rounded-md bg-background p-3 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
            href="#conversation"
          >
            {t('跳到聊天')}
          </a>
          <aside
            className="hidden min-h-0 flex-col border-r bg-muted/35 md:flex"
            aria-label={t('个人聊天目录')}
          >
            <div
              className={cn(
                'flex h-14 shrink-0 items-center gap-2 border-b px-3',
                collapsed && 'justify-center px-2',
              )}
            >
              <a
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold',
                  collapsed && 'hidden',
                )}
                href="/"
              >
                <MessageSquare className="size-4" />
                MkHarness
              </a>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={toggleLabel}
                    aria-expanded={!collapsed}
                    aria-controls="sidebar-directory"
                    onClick={() => setCollapsed((value) => !value)}
                  >
                    {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{toggleLabel}</TooltipContent>
              </Tooltip>
            </div>
            <div
              id="sidebar-directory"
              className={cn('min-h-0 flex-1 overflow-hidden', collapsed && 'hidden')}
            >
              {content}
            </div>
            {collapsed && (
              <div className="flex-1 p-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('新建聊天')}
                      disabled={!onNewChat || creating}
                      onClick={onNewChat}
                    >
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {creating ? t('创建中…') : t('新建聊天')}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            <footer className="shrink-0 border-t p-2">{footer(collapsed)}</footer>
          </aside>
          <SheetContent side="left" className="w-72 gap-0 bg-muted p-0">
            <SheetHeader className="flex h-14 shrink-0 justify-center border-b px-6 py-0">
              <SheetTitle className="flex items-center gap-2 text-sm">
                <MessageSquare className="size-4" />
                MkHarness
              </SheetTitle>
              <SheetDescription className="sr-only">
                {t('选择已有聊天或开始新聊天；账号和登录位于底部')}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
            <footer className="shrink-0 border-t p-2">{footer(false)}</footer>
          </SheetContent>
          <main
            id="conversation"
            tabIndex={-1}
            className="flex min-h-0 min-w-0 flex-col outline-none"
          >
            <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-8">
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="md:hidden"
                  aria-label={t('打开聊天目录')}
                >
                  <PanelLeft />
                </Button>
              </SheetTrigger>
              {title ? (
                <h1 className="truncate text-sm font-medium">{title}</h1>
              ) : (
                <span className="text-sm font-medium">{t('新聊天')}</span>
              )}
            </header>
            {children}
          </main>
        </div>
      </Sheet>
    </TooltipProvider>
  );
}

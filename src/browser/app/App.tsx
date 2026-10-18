import { useLocale } from './locale';
import { useCallback, useEffect, useState } from 'react';
import { authClient } from './auth';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { directoryOptions, userKeys } from '../queries';
import { Button } from '../ui/button';
import { ResourceDrafts } from '../extensions/ResourceDrafts';
import { ConversationActions } from './ConversationActions';
import { AppShell } from './AppShell';
import { Plus, LogIn, LogOut, Settings, ChevronsUpDown } from 'lucide-react';
import { Alert, AlertDescription } from '../ui/alert';
import { Skeleton } from '../ui/skeleton';
import { ScrollArea } from '../ui/scroll-area';
import { SettingsDialog } from '../settings/Settings';
import { retainModelKeys } from '../models/local-model-key';
import { Chat } from '../chat/Chat';
import { Delayed } from '../ui/delayed';
import { useBrowserExtensions } from '../extensions/extension-loading';
import { useSkillSelection } from '../../extensions/skills/selection';
import { cn } from '../ui/utils';
import { WorkbenchProvider, useWorkbench } from '../workbench/panel-host';
import { ComposerDraftsProvider, useComposerDrafts } from '../workbench/composer-drafts';
import {
  WorkbenchNavigation,
  WorkbenchPlaceholder,
  type WorkbenchView,
} from '../workbench/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
type AuthState = ReturnType<typeof authClient.useSession>;
type WorkspaceProps = {
  name: string;
  userId: string;
  sessionError: AuthState['error'];
  retrySession: () => void;
};
export function App() {
  const { data: session, isPending, error: sessionError, refetch } = authClient.useSession();
  const queryClient = useQueryClient();
  const sessionId = session?.user.id;
  useEffect(() => {
    if (!isPending && !sessionError) retainModelKeys(sessionId);
  }, [isPending, sessionId, sessionError]);
  useEffect(() => {
    // Clear the previous account, without cancelling reads mounted for the new one.
    queryClient.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === 'user' && (!sessionId || query.queryKey[1] !== sessionId),
    });
  }, [queryClient, sessionId]);
  // Mount the workspace once its account is known; there is no startup replica.
  // A background session refresh keeps the existing workspace visible.
  if (isPending && !session) return null;
  return (
    <Workspace
      name={session?.user.name ?? ''}
      userId={sessionId ?? ''}
      sessionError={sessionError}
      retrySession={() => void refetch()}
    />
  );
}
function Workspace(props: WorkspaceProps) {
  const { chat = '', view = 'agent' } = useSearch({ from: '/' });
  return (
    <WorkbenchProvider userId={props.userId} chatId={chat} visible={view === 'agent'}>
      <ComposerDraftsProvider userId={props.userId}>
        <WorkspaceContents {...props} />
      </ComposerDraftsProvider>
    </WorkbenchProvider>
  );
}
function WorkspaceContents({ name, userId, sessionError, retrySession }: WorkspaceProps) {
  const { t } = useLocale();
  // Start capability discovery and reviewed module downloads while Chat and its
  // snapshot load. The runtime reuses these same user-scoped query results.
  const extensions = useBrowserExtensions(userId);
  const { chat: requestedId = '', view = 'agent', mcp } = useSearch({ from: '/' });
  const id = userId ? requestedId : '';
  const workbench = useWorkbench();
  const composerDrafts = useComposerDrafts();
  const navigate = useNavigate({ from: '/' });
  const skillSelection = useSkillSelection(
    userId,
    !!userId && !id && extensions.capabilities.data?.skills === true,
  );
  const client = useQueryClient();
  useEffect(
    () => () => {
      // HTTP receipts are transient workspace state, never shared across accounts.
      for (const mutation of client.getMutationCache().findAll({
        mutationKey: userKeys(userId).submissions,
        exact: true,
      }))
        client.getMutationCache().remove(mutation);
    },
    [client, userId],
  );
  const directoryQuery = useInfiniteQuery({ ...directoryOptions(userId), enabled: !!userId });
  const items = directoryQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const next = directoryQuery.hasNextPage;
  const loading = !!userId && (directoryQuery.isPending || directoryQuery.isFetching);
  const [menu, setMenu] = useState(false),
    [error, setError] = useState(''),
    [settingsOpen, setSettingsOpen] = useState(!!mcp),
    [settingsSection, setSettingsSection] = useState<'general' | 'models' | 'connections'>(() =>
      mcp ? 'connections' : 'general',
    ),
    [settingsProvider, setSettingsProvider] = useState<string>(),
    [activeProvider, setActiveProvider] = useState<string>(),
    [signingOut, setSigningOut] = useState(false),
    [signingIn, setSigningIn] = useState(false);
  const resetSkills = skillSelection.setSelected;
  useEffect(() => {
    setError('');
    setSettingsOpen(!!mcp);
    setSettingsProvider(undefined);
    setActiveProvider(undefined);
    setSigningIn(false);
    setSigningOut(false);
    resetSkills(undefined);
  }, [userId, mcp, resetSkills]);
  const showSettings = useCallback((provider?: string) => {
    setSettingsProvider(provider);
    setSettingsSection('models');
    setSettingsOpen(true);
  }, []);
  const refreshDirectory = useCallback(() => {
    void client.invalidateQueries({ queryKey: userKeys(userId).directory });
  }, [client, userId]);
  const choose = useCallback(
    (value: string, replace = false) => {
      void navigate({
        search: (previous) => ({
          ...previous,
          chat: value || undefined,
          view: undefined,
          mcp: undefined,
        }),
        replace,
      });
      setMenu(false);
    },
    [navigate],
  );
  const deleted = (value: string) => {
    workbench?.removeChat(value);
    composerDrafts?.remove(value);
    client.removeQueries({ queryKey: userKeys(userId).snapshot(value) });
    for (const mutation of client.getMutationCache().findAll({
      mutationKey: userKeys(userId).submissions,
      exact: true,
      predicate: (mutation) =>
        (mutation.state.variables as { id?: string } | undefined)?.id === value,
    }))
      client.getMutationCache().remove(mutation);
    if (id === value) choose(items.find((item) => item.id !== value)?.id ?? '', true);
    refreshDirectory();
  };
  const create = () => choose('');
  const changeView = (value: WorkbenchView) => {
    void navigate({
      search: (previous) => ({
        ...previous,
        view: value === 'agent' ? undefined : value,
        mcp: undefined,
      }),
    });
    setMenu(false);
  };
  const current = items.find((item) => item.id === id);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const groups = [
    { label: t('Today'), items: items.filter((item) => item.updated_at >= today.getTime()) },
    { label: t('Earlier'), items: items.filter((item) => item.updated_at < today.getTime()) },
  ];
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setMenu(false);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? '退出失败');
      retainModelKeys();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSigningOut(false);
    }
  };
  const directory = (
    <div className="flex h-full min-h-0 flex-col gap-5 p-4">
      <Button variant="outline" className="w-full justify-start" onClick={() => void create()}>
        <Plus className="size-4" />
        {t('新建聊天')}
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {loading && !items.length && (
          <Delayed>
            <div className="space-y-2" role="status" aria-label={t('正在读取目录')}>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-4/5" />
            </div>
          </Delayed>
        )}
        {!loading && !!userId && !items.length && (
          <p className="px-2 py-4 text-sm text-muted-foreground">{t('第一段对话，从这里开始。')}</p>
        )}
        {!userId && (
          <p className="px-2 text-sm text-muted-foreground">{t('登录后，在这里继续你的聊天。')}</p>
        )}
        <ScrollArea className="-mx-4 min-h-0 flex-1">
          <nav className="space-y-4 px-4" aria-label={t('聊天记录')}>
            {groups
              .filter((group) => group.items.length)
              .map((group) => (
                <section key={group.label} className="space-y-1" aria-label={group.label}>
                  <h2 className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </h2>
                  {group.items.map((item) => (
                    <div
                      key={item.id}
                      role="group"
                      aria-label={t('聊天：{title}', { title: item.title })}
                      className="group/chat flex items-center rounded-md has-[button[aria-current=page]]:bg-accent"
                    >
                      <Button
                        variant="ghost"
                        aria-current={id === item.id ? 'page' : undefined}
                        className="h-auto min-w-0 flex-1 justify-start px-2 py-2 text-left font-medium text-muted-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
                        onClick={() => choose(item.id)}
                      >
                        <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      </Button>
                      <ConversationActions
                        id={item.id}
                        title={item.title}
                        onRenamed={() => {
                          refreshDirectory();
                        }}
                        onDeleted={() => deleted(item.id)}
                      />
                    </div>
                  ))}
                </section>
              ))}
            {next && (
              <Button
                variant="ghost"
                className="w-full"
                disabled={loading}
                onClick={() => void directoryQuery.fetchNextPage()}
              >
                {t('更多聊天')}
              </Button>
            )}
          </nav>
        </ScrollArea>
      </div>
    </div>
  );
  return (
    <ResourceDrafts scope={userId}>
      <AppShell
        menu={menu}
        onMenuChange={setMenu}
        directory={directory}
        navigation={(collapsed) => (
          <WorkbenchNavigation view={view} collapsed={collapsed} onChange={changeView} />
        )}
        title={
          view === 'agent'
            ? id
              ? (current?.title ?? t('聊天'))
              : undefined
            : t(view === 'schedules' ? '定时任务' : '插件市场')
        }
        onNewChat={() => void create()}
        footer={(collapsed) =>
          userId ? (
            <AccountMenu
              name={name}
              collapsed={collapsed}
              busy={signingOut}
              onSettings={() => {
                setSettingsProvider(activeProvider);
                setSettingsSection('general');
                setSettingsOpen(true);
              }}
              onSignOut={() => void signOut()}
            />
          ) : (
            <Button
              variant="ghost"
              className={cn('h-12 w-full justify-start px-3', collapsed && 'justify-center px-0')}
              aria-label={signingIn ? t('正在打开登录…') : t('使用 Google 登录')}
              disabled={signingIn || !!sessionError}
              onClick={async () => {
                setSigningIn(true);
                setError('');
                setMenu(false);
                try {
                  const result = await authClient.signIn.social({
                    provider: 'google',
                    callbackURL: location.origin,
                  });
                  if (result.error) throw new Error(result.error.message ?? '登录失败，请重试');
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setSigningIn(false);
                }
              }}
            >
              <LogIn className="size-4 shrink-0" />
              <span className={collapsed ? 'sr-only' : undefined}>
                {signingIn ? t('正在打开登录…') : t('使用 Google 登录')}
              </span>
            </Button>
          )
        }
      >
        {(error || sessionError || directoryQuery.error) && (
          <Alert variant="destructive" className="mx-4 mt-4 w-auto">
            <AlertDescription>
              {t(error || sessionError?.message || directoryQuery.error?.message || '')}
              {sessionError && (
                <Button variant="link" onClick={retrySession}>
                  {t('重试')}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
        <div
          className="flex min-h-0 flex-1 flex-col"
          hidden={view !== 'agent'}
          style={view !== 'agent' ? { display: 'none' } : undefined}
        >
          <Chat
            key={id}
            id={id}
            userId={userId}
            onDirectoryChange={refreshDirectory}
            onUnavailable={() => deleted(id)}
            onCreated={(value) => {
              refreshDirectory();
              choose(value);
            }}
            onSettings={showSettings}
            onModelProviderChange={setActiveProvider}
            creation={
              extensions.capabilities.data?.skills && skillSelection.creationIds !== undefined
                ? { skillIds: skillSelection.creationIds }
                : undefined
            }
          />
        </div>
        {view !== 'agent' && <WorkbenchPlaceholder view={view} />}
        {!!userId && (
          <SettingsDialog
            key={userId}
            userId={userId}
            customMcp={extensions.capabilities.data?.customMcp === true}
            skills={extensions.capabilities.data?.skills === true}
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            initialProvider={settingsProvider}
            initialSection={settingsSection}
          />
        )}
      </AppShell>
    </ResourceDrafts>
  );
}

function AccountMenu({
  name,
  collapsed,
  busy,
  onSignOut,
  onSettings,
}: {
  name: string;
  collapsed: boolean;
  busy: boolean;
  onSignOut: () => void;
  onSettings: () => void;
}) {
  const { t } = useLocale();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'h-12 w-full justify-start gap-3 px-2 font-medium',
            collapsed && 'justify-center px-0',
          )}
          aria-label={t('账号：{name}', { name })}
          title={collapsed ? name : undefined}
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-medium"
          >
            {Array.from(name.trim())[0]?.toUpperCase() ?? 'U'}
          </span>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium">{name}</span>
                <span className="block text-xs text-muted-foreground">{t('个人账号')}</span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="truncate">{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSettings}>
          <Settings />
          {t('设置')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={onSignOut}>
          <LogOut />
          {busy ? t('正在退出…') : t('退出登录')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

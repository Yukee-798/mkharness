import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { authClient } from './auth';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery, useQueryClient, useQuery } from '@tanstack/react-query';
import { ensureGuestSession } from './session-bootstrap';
import { directoryOptions, userKeys } from './queries';
import { request } from './api';
import { Button } from './ui/button';
import { ResourceDrafts } from './ResourceDrafts';
import { ConversationActions } from './ConversationActions';
import { AppShell } from './AppShell';
import { Plus, LogIn, LogOut, Settings, ChevronsUpDown } from 'lucide-react';
import { Alert, AlertDescription } from './ui/alert';
import { Skeleton } from './ui/skeleton';
import { ScrollArea } from './ui/scroll-area';
import { ModelSettingsDialog } from './ModelSettings';
import { ChatLoading } from './chat-loading';
import { cn } from './ui/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
const Chat = lazy(() => import('./Chat').then((module) => ({ default: module.Chat })));
export function App() {
  const { data: session, isPending, error: sessionError, refetch } = authClient.useSession();
  const bootstrap = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => request<{ authMode: 'guest' | 'account' }>('/bootstrap'),
    staleTime: Infinity,
    retry: false,
  });
  const queryClient = useQueryClient();
  const sessionId = session?.user.id;
  useEffect(() => {
    // Clear the previous account, without cancelling reads mounted for the new one.
    queryClient.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === 'user' && (!sessionId || query.queryKey[1] !== sessionId),
    });
  }, [queryClient, sessionId]);
  const [error, setError] = useState(''),
    [signingIn, setSigningIn] = useState(false),
    [guestFailed, setGuestFailed] = useState(false),
    [menu, setMenu] = useState(false);
  useEffect(() => {
    if (bootstrap.data?.authMode !== 'guest' || isPending || session || sessionError || guestFailed)
      return;
    let active = true;
    setSigningIn(true);
    void ensureGuestSession()
      .then(() => refetch())
      .catch(() => {
        if (active) {
          setError('无法建立浏览器身份，请重试');
          setGuestFailed(true);
        }
      })
      .finally(() => {
        if (active) setSigningIn(false);
      });
    return () => {
      active = false;
    };
  }, [bootstrap.data?.authMode, isPending, session, sessionError, guestFailed, refetch]);
  if (
    bootstrap.error ||
    (session &&
      bootstrap.data &&
      Boolean(session.user.isAnonymous) !== (bootstrap.data.authMode === 'guest'))
  )
    return (
      <main className="m-auto max-w-md p-6">
        <Alert variant="destructive">
          <AlertDescription>
            {bootstrap.error
              ? bootstrap.error.message
              : '当前身份不适用于此部署模式，请退出后重新进入'}
          </AlertDescription>
        </Alert>
        <Button
          className="mt-4"
          onClick={() => {
            if (bootstrap.error) void bootstrap.refetch();
            else void authClient.signOut();
          }}
        >
          {bootstrap.error ? '重试' : '退出当前身份'}
        </Button>
      </main>
    );
  if (isPending || bootstrap.isPending || (!session && bootstrap.data?.authMode === 'guest'))
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <p role="status" className="text-sm text-muted-foreground">
          {error || sessionError?.message || (signingIn ? '正在建立浏览器身份…' : '正在恢复身份…')}
        </p>
        {(guestFailed || sessionError) && (
          <Button
            onClick={() => {
              setError('');
              setGuestFailed(false);
              void refetch();
            }}
          >
            重试
          </Button>
        )}
      </main>
    );
  if (!session)
    return (
      <AppShell
        menu={menu}
        onMenuChange={setMenu}
        footer={(collapsed) => (
          <Button
            variant="ghost"
            className={cn('h-12 w-full justify-start px-3', collapsed && 'justify-center px-0')}
            aria-label={signingIn ? '正在打开登录…' : '使用 Google 登录'}
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
              {signingIn ? '正在打开登录…' : '使用 Google 登录'}
            </span>
          </Button>
        )}
      >
        <div className="flex min-h-0 flex-1 overflow-y-auto">
          <div className="m-auto w-full max-w-md shrink-0 px-6 py-12">
            <h1 className="text-3xl leading-tight font-semibold tracking-tight">
              把问题变成
              <br />
              可以操作的答案。
            </h1>
            <p className="mt-4 mb-8 text-sm leading-relaxed text-muted-foreground">
              对话、探索和调整参数。在自己的聊天中继续每一项任务。
            </p>
            {(error || sessionError) && (
              <Alert variant="destructive" className="mt-4">
                <AlertDescription>
                  {error || sessionError?.message || '无法读取登录配置，请检查服务端设置'}{' '}
                  {sessionError && (
                    <Button variant="link" onClick={() => void refetch()}>
                      重试
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              从侧栏底部使用 Google 登录。聊天和输入仅保存在你的个人会话中。
            </p>
          </div>
        </div>
      </AppShell>
    );
  return (
    <Workspace
      key={session.user.id}
      name={session.user.isAnonymous ? '此浏览器的访客' : session.user.name}
      userId={session.user.id}
      anonymous={Boolean(session.user.isAnonymous)}
    />
  );
}
function Workspace({
  name,
  userId,
  anonymous,
}: {
  name: string;
  userId: string;
  anonymous: boolean;
}) {
  const { chat: id = '' } = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });
  const client = useQueryClient();
  const directoryQuery = useInfiniteQuery(directoryOptions(userId));
  const items = directoryQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const next = directoryQuery.hasNextPage;
  const loading = directoryQuery.isPending || directoryQuery.isFetching;
  const [menu, setMenu] = useState(false),
    [error, setError] = useState(''),
    [settingsOpen, setSettingsOpen] = useState(false),
    [settingsProvider, setSettingsProvider] = useState<string>(),
    [signingOut, setSigningOut] = useState(false);
  const showSettings = useCallback((provider?: string) => {
    setSettingsProvider(provider);
    setSettingsOpen(true);
  }, []);
  const refreshDirectory = useCallback(() => {
    void client.invalidateQueries({ queryKey: userKeys(userId).directory });
  }, [client, userId]);
  const choose = useCallback(
    (value: string, replace = false) => {
      void navigate({ search: value ? { chat: value } : {}, replace });
      setMenu(false);
    },
    [navigate],
  );
  const deleted = (value: string) => {
    client.removeQueries({ queryKey: userKeys(userId).snapshot(value) });
    if (id === value) choose(items.find((item) => item.id !== value)?.id ?? '', true);
    refreshDirectory();
  };
  const create = () => choose('');
  const current = items.find((item) => item.id === id);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const groups = [
    { label: 'Today', items: items.filter((item) => item.updated_at >= today.getTime()) },
    { label: 'Earlier', items: items.filter((item) => item.updated_at < today.getTime()) },
  ];
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setMenu(false);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? '退出失败');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSigningOut(false);
    }
  };
  const directory = (
    <div className="flex h-full min-h-0 flex-col gap-5 p-4">
      <Button
        variant="outline"
        className="w-full justify-start"

        onClick={() => void create()}
      >
        <Plus className="size-4" />
        新建聊天
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {loading && !items.length && (
          <div className="space-y-2" role="status" aria-label="正在读取目录">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-4/5" />
          </div>
        )}
        {!loading && !items.length && (
          <p className="px-2 py-4 text-sm text-muted-foreground">第一段对话，从这里开始。</p>
        )}
        <ScrollArea className="-mx-4 min-h-0 flex-1">
          <nav className="space-y-4 px-4" aria-label="聊天记录">
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
                      aria-label={`聊天：${item.title}`}
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
                更多聊天
              </Button>
            )}
          </nav>
        </ScrollArea>
      </div>
    </div>
  );
  return (
    <ResourceDrafts>
      <AppShell
        menu={menu}
        onMenuChange={setMenu}
        directory={directory}
        title={id ? (current?.title ?? '聊天') : undefined}
        onNewChat={() => void create()}
        footer={(collapsed) => (
          <AccountMenu
            name={name}
            anonymous={anonymous}
            collapsed={collapsed}
            busy={signingOut}
            onSettings={() => showSettings()}
            onSignOut={() => void signOut()}
          />
        )}
      >
        {(error || directoryQuery.error) && (
          <Alert variant="destructive" className="mx-4 mt-4 w-auto">
            <AlertDescription>{error || directoryQuery.error?.message}</AlertDescription>
          </Alert>
        )}
        <Suspense fallback={<ChatLoading />}>
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
          />
        </Suspense>
        <ModelSettingsDialog
          userId={userId}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          initialProvider={settingsProvider}
        />
      </AppShell>
    </ResourceDrafts>
  );
}

function AccountMenu({
  name,
  anonymous,
  collapsed,
  busy,
  onSignOut,
  onSettings,
}: {
  name: string;
  anonymous: boolean;
  collapsed: boolean;
  busy: boolean;
  onSignOut: () => void;
  onSettings: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'h-12 w-full justify-start gap-3 px-2 font-medium',
            collapsed && 'justify-center px-0',
          )}
          aria-label={`账号：${name}`}
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
                <span className="block text-xs text-muted-foreground">
                  {anonymous ? '身份保留在此浏览器' : '个人账号'}
                </span>
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
          模型与 API Key
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={onSignOut}>
          <LogOut />
          {busy ? '正在退出…' : '退出登录'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

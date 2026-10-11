import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { authClient } from './auth';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { directoryOptions, userKeys } from './queries';
import { request } from './api';
import { Button } from './ui/button';
import { ResourceDrafts } from './ResourceDrafts';
import { ConversationActions } from './ConversationActions';
import { AppShell } from './AppShell';
import { MessageSquare, Plus, LogIn, LogOut, ArrowRight, ChevronsUpDown } from 'lucide-react';
import { Alert, AlertDescription } from './ui/alert';
import { Skeleton } from './ui/skeleton';
import { ScrollArea } from './ui/scroll-area';
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
  const queryClient = useQueryClient();
  const sessionId = session?.user.id;
  useEffect(() => {
    // Clear the previous account, without cancelling reads mounted for the new one.
    queryClient.removeQueries({
      predicate: (query) =>
        !sessionId || (query.queryKey[0] === 'user' && query.queryKey[1] !== sessionId),
    });
  }, [queryClient, sessionId]);
  const [error, setError] = useState(''),
    [signingIn, setSigningIn] = useState(false),
    [menu, setMenu] = useState(false);
  if (isPending)
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <p role="status" className="text-sm text-muted-foreground">
          正在恢复登录状态…
        </p>
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
  return <Workspace key={session.user.id} name={session.user.name} userId={session.user.id} />;
}
function Workspace({ name, userId }: { name: string; userId: string }) {
  const { chat: id = '' } = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });
  const client = useQueryClient();
  const directoryQuery = useInfiniteQuery(directoryOptions(userId));
  const items = directoryQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const next = directoryQuery.hasNextPage;
  const loading = directoryQuery.isPending || directoryQuery.isFetching;
  const [menu, setMenu] = useState(false),
    [error, setError] = useState(''),
    [creating, setCreating] = useState(false),
    [signingOut, setSigningOut] = useState(false);
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
  useEffect(() => {
    const data = directoryQuery.data;
    if (
      id &&
      data &&
      !directoryQuery.isFetching &&
      !directoryQuery.hasNextPage &&
      !data.pages.some((page) => page.items.some((item) => item.id === id))
    ) {
      choose(data.pages[0]?.items[0]?.id ?? '', true);
    }
  }, [id, directoryQuery.data, directoryQuery.isFetching, directoryQuery.hasNextPage, choose]);
  const deleted = (value: string) => {
    client.removeQueries({ queryKey: userKeys(userId).snapshot(value) });
    if (id === value) choose(items.find((item) => item.id !== value)?.id ?? '', true);
    refreshDirectory();
  };
  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const chat = await request<{ id: string; title: string }>('/conversations', {
        method: 'POST',
      });
      // Await the directory read before navigation, so stale cache cannot reject the new ID.
      await client.invalidateQueries({ queryKey: userKeys(userId).directory });
      choose(chat.id);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };
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
        disabled={creating}
        onClick={() => void create()}
      >
        <Plus className="size-4" />
        {creating ? '创建中…' : '新建聊天'}
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
        creating={creating}
        footer={(collapsed) => (
          <AccountMenu
            name={name}
            collapsed={collapsed}
            busy={signingOut}
            onSignOut={() => void signOut()}
          />
        )}
      >
        {(error || directoryQuery.error) && (
          <Alert variant="destructive" className="mx-4 mt-4 w-auto">
            <AlertDescription>{error || directoryQuery.error?.message}</AlertDescription>
          </Alert>
        )}
        {id ? (
          <Suspense fallback={<ChatLoading />}>
            <Chat
              key={id}
              id={id}
              userId={userId}
              onDirectoryChange={refreshDirectory}
              onUnavailable={() => deleted(id)}
            />
          </Suspense>
        ) : (
          <div className="m-auto max-w-md px-6 py-12 text-center">
            <MessageSquare className="mx-auto mb-5 size-8 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">从一个问题开始。</h1>
            <p className="mt-3 mb-6 text-sm leading-relaxed text-muted-foreground">
              提出问题、比较方案，或一起探索数据与想法。
            </p>
            <Button disabled={creating} onClick={() => void create()}>
              开始新聊天
              <ArrowRight className="size-4" />
            </Button>
          </div>
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
}: {
  name: string;
  collapsed: boolean;
  busy: boolean;
  onSignOut: () => void;
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
                <span className="block text-xs text-muted-foreground">个人账号</span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="truncate">{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={onSignOut}>
          <LogOut />
          {busy ? '正在退出…' : '退出登录'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

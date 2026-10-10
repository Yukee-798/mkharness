import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { authClient } from './auth';
import { request } from './api';
import { Button } from './ui/button';
import { PanelDrafts } from './PanelDrafts';
import { ConversationActions } from './ConversationActions';
import { AppShell } from './AppShell';
import { MessageSquare, Plus, LogIn, LogOut, ArrowRight, ChevronsUpDown } from 'lucide-react';
import { Alert, AlertDescription } from './ui/alert';
import { Skeleton } from './ui/skeleton';
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
type Conversation = { id: string; title: string; updated_at: number };
type Directory = { items: Conversation[]; next: string | null };
function selectedChat() {
  return new URL(location.href).searchParams.get('chat') ?? '';
}
export function App() {
  const { data: session, isPending, error: sessionError, refetch } = authClient.useSession();
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
  return <Workspace key={session.user.id} name={session.user.name} />;
}
function Workspace({ name }: { name: string }) {
  const [items, setItems] = useState<Conversation[]>([]),
    [next, setNext] = useState<string | null>(null),
    [id, setId] = useState(selectedChat),
    [menu, setMenu] = useState(false),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [creating, setCreating] = useState(false),
    [signingOut, setSigningOut] = useState(false),
    [version, setVersion] = useState(0),
    [pages, setPages] = useState(1);
  const refreshDirectory = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    const selectionAtStart = selectedChat();
    setLoading(true);
    void (async () => {
      const data = await request<Directory>('/conversations', { signal: controller.signal });
      // Reload the visible pages together so reordered chats do not duplicate or disappear.
      for (let page = 1; page < pages && data.next; page++) {
        const more = await request<Directory>(
          '/conversations?cursor=' + encodeURIComponent(data.next),
          { signal: controller.signal },
        );
        data.items.push(...more.items);
        data.next = more.next;
      }
      if (!controller.signal.aborted) {
        setItems(data.items);
        setNext(data.next);
        setError('');
        // Only an exhaustive list can confirm a chat was removed in another tab.
        if (
          selectionAtStart &&
          selectedChat() === selectionAtStart &&
          !data.next &&
          !data.items.some((chat) => chat.id === selectionAtStart)
        ) {
          const fallback = data.items[0]?.id ?? '';
          const url = new URL(location.href);
          if (fallback) url.searchParams.set('chat', fallback);
          else url.searchParams.delete('chat');
          history.replaceState(null, '', url);
          setId(fallback);
          setMenu(false);
        }
      }
    })()
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [version, pages]);
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshDirectory();
    };
    addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshDirectory]);
  useEffect(() => {
    const pop = () => {
      setId(selectedChat());
      setMenu(false);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  const choose = (value: string, replace = false) => {
    const url = new URL(location.href);
    if (value) url.searchParams.set('chat', value);
    else url.searchParams.delete('chat');
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    setId(value);
    setMenu(false);
  };
  const deleted = (value: string) => {
    setItems((current) => current.filter((item) => item.id !== value));
    if (selectedChat() === value) choose(items.find((item) => item.id !== value)?.id ?? '', true);
    refreshDirectory();
  };
  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const chat = await request<{ id: string; title: string }>('/conversations', {
        method: 'POST',
      });
      setItems((current) => [{ ...chat, updated_at: Date.now() }, ...current]);
      choose(chat.id);
      refreshDirectory();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };
  const current = items.find((item) => item.id === id);
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
        <h2 className="px-2 text-xs font-medium text-muted-foreground">聊天记录</h2>
        {loading && !items.length && (
          <div className="space-y-2" role="status" aria-label="正在读取目录">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-4/5" />
          </div>
        )}
        {!loading && !items.length && (
          <p className="px-2 py-4 text-sm text-muted-foreground">第一段对话，从这里开始。</p>
        )}
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label="聊天记录">
          {items.map((item) => (
            <div
              key={item.id}
              role="group"
              aria-label={`聊天：${item.title}`}
              className="group/chat flex items-center rounded-md has-[button[aria-current=page]]:bg-accent"
            >
              <Button
                variant="ghost"
                aria-current={id === item.id ? 'page' : undefined}
                className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-2.5 text-left font-normal aria-[current=page]:font-medium"
                onClick={() => choose(item.id)}
              >
                <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <time
                  className="shrink-0 text-[10px] text-muted-foreground"
                  dateTime={new Date(item.updated_at).toISOString()}
                >
                  {new Date(item.updated_at).toLocaleDateString('zh-CN', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              </Button>
              <ConversationActions
                id={item.id}
                title={item.title}
                onRenamed={(title) => {
                  setItems((current) =>
                    current.map((chat) => (chat.id === item.id ? { ...chat, title } : chat)),
                  );
                  refreshDirectory();
                }}
                onDeleted={() => deleted(item.id)}
              />
            </div>
          ))}
          {next && (
            <Button
              variant="ghost"
              className="w-full"
              disabled={loading}
              onClick={() => setPages((value) => value + 1)}
            >
              更多聊天
            </Button>
          )}
        </nav>
      </div>
    </div>
  );
  return (
    <PanelDrafts>
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
        {error && (
          <Alert variant="destructive" className="mx-4 mt-4 w-auto">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {id ? (
          <Suspense
            fallback={
              <p role="status" className="p-8 text-sm text-muted-foreground">
                正在打开聊天…
              </p>
            }
          >
            <Chat
              key={id}
              id={id}
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
    </PanelDrafts>
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
            'h-12 w-full justify-start gap-3 px-2 font-normal',
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

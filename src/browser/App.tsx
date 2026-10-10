import { lazy, Suspense, useEffect, useState } from 'react';
import { authClient } from './auth';
import { request } from './api';
import { Button } from './ui/button';
import { PanelDrafts } from './PanelDrafts';
import { MessageSquare, PanelLeft, Plus, RefreshCw, LogOut, ArrowRight } from 'lucide-react';
import { Alert, AlertDescription } from './ui/alert';
import { Separator } from './ui/separator';
import { Skeleton } from './ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from './ui/sheet';
const Chat = lazy(() => import('./Chat').then((module) => ({ default: module.Chat })));
type Conversation = { id: string; title: string; updated_at: number };
type Directory = { items: Conversation[]; next: string | null };
function selectedChat() {
  return new URL(location.href).searchParams.get('chat') ?? '';
}
export function App() {
  const { data: session, isPending, error: sessionError, refetch } = authClient.useSession();
  const [error, setError] = useState(''),
    [signingIn, setSigningIn] = useState(false);
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
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
        <span className="mb-8 flex items-center gap-2 text-sm font-semibold">
          <MessageSquare className="size-5" />
          Agent UI
        </span>
        <h1 className="text-3xl leading-tight font-semibold tracking-tight">
          把问题变成
          <br />
          可以操作的答案。
        </h1>
        <p className="mt-4 mb-8 text-sm leading-relaxed text-muted-foreground">
          对话、探索和调整参数。在自己的聊天中继续每一项任务。
        </p>
        <Button
          size="lg"
          disabled={signingIn || !!sessionError}
          onClick={async () => {
            setSigningIn(true);
            setError('');
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
          {signingIn ? '正在打开登录…' : '使用 Google 登录'}
        </Button>
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
          登录后，聊天和输入仅保存在你的个人会话中。
        </p>
      </main>
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
    [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void request<Directory>('/conversations', { signal: controller.signal })
      .then((data) => {
        setItems(data.items);
        setNext(data.next);
        setError('');
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [version]);
  useEffect(() => {
    const pop = () => {
      setId(selectedChat());
      setMenu(false);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  const choose = (value: string) => {
    const url = new URL(location.href);
    url.searchParams.set('chat', value);
    history.pushState(null, '', url);
    setId(value);
    setMenu(false);
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
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };
  const current = items.find((item) => item.id === id);
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
        {loading && (
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
            <Button
              key={item.id}
              variant="ghost"
              aria-current={id === item.id ? 'page' : undefined}
              className="h-auto w-full justify-start gap-2 px-2 py-2.5 text-left font-normal aria-[current=page]:bg-accent aria-[current=page]:font-medium"
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
          ))}
          {next && (
            <Button
              variant="ghost"
              className="w-full"
              onClick={async () => {
                try {
                  const data = await request<Directory>(
                    '/conversations?cursor=' + encodeURIComponent(next),
                  );
                  setItems((old) => [...old, ...data.items]);
                  setNext(data.next);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              更多聊天
            </Button>
          )}
        </nav>
      </div>
      <Separator />
      <Button
        variant="ghost"
        className="justify-start text-muted-foreground"
        onClick={() => setVersion((v) => v + 1)}
      >
        <RefreshCw className="size-4" />
        刷新目录
      </Button>
    </div>
  );
  return (
    <PanelDrafts>
      <Sheet open={menu} onOpenChange={setMenu}>
        <div className="grid h-dvh grid-cols-1 grid-rows-[3.5rem_minmax(0,1fr)] overflow-hidden md:grid-cols-[16rem_minmax(0,1fr)]">
          <a
            className="sr-only z-50 rounded-md bg-background p-3 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
            href="#conversation"
          >
            跳到聊天
          </a>
          <header className="col-span-full flex items-center gap-3 border-b px-4 md:px-6">
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="打开聊天目录">
                <PanelLeft className="size-4" />
              </Button>
            </SheetTrigger>
            <a className="flex items-center gap-2 text-sm font-semibold" href="/">
              <MessageSquare className="size-4" />
              Agent UI
            </a>
            <span className="ml-auto max-w-32 truncate text-sm text-muted-foreground">{name}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  const result = await authClient.signOut();
                  if (result.error) throw new Error(result.error.message ?? '退出失败');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">退出</span>
              <span className="sr-only sm:hidden">退出</span>
            </Button>
          </header>
          <aside className="hidden min-h-0 border-r bg-muted/35 md:block" aria-label="个人聊天目录">
            {directory}
          </aside>
          <SheetContent side="left" className="w-72 gap-0 p-0">
            <SheetHeader className="border-b px-6 py-4">
              <SheetTitle className="text-sm">你的聊天</SheetTitle>
              <SheetDescription className="sr-only">选择已有聊天或开始新聊天</SheetDescription>
            </SheetHeader>
            {directory}
          </SheetContent>
          <main
            id="conversation"
            tabIndex={-1}
            className="flex min-h-0 min-w-0 flex-col outline-none"
          >
            {error && (
              <Alert variant="destructive" className="mx-4 mt-4 w-auto">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {id ? (
              <>
                <div className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 md:px-8">
                  <h1 className="truncate text-sm font-medium">{current?.title ?? '聊天'}</h1>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    离开页面后，任务会继续运行
                  </span>
                </div>
                <Suspense
                  fallback={
                    <p role="status" className="p-8 text-sm text-muted-foreground">
                      正在打开聊天…
                    </p>
                  }
                >
                  <Chat key={id} id={id} />
                </Suspense>
              </>
            ) : (
              <div className="m-auto max-w-md px-6 py-12 text-center">
                <MessageSquare className="mx-auto mb-5 size-8 text-muted-foreground" />
                <h1 className="text-2xl font-semibold tracking-tight">从一个问题开始。</h1>
                <p className="mt-3 mb-6 text-sm leading-relaxed text-muted-foreground">
                  需要解释时，直接对话。需要比较和模拟时，让 Agent 生成可交互的面板。
                </p>
                <Button disabled={creating} onClick={() => void create()}>
                  开始新聊天
                  <ArrowRight className="size-4" />
                </Button>
              </div>
            )}
          </main>
        </div>
      </Sheet>
    </PanelDrafts>
  );
}

import { useLocale } from '../app/locale';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScenarioInstance } from '../../shared/workspace';
import { request } from '../api';
import { workspaceError } from './error';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { ScrollArea } from '../ui/scroll-area';
import { Alert, AlertDescription } from '../ui/alert';
import { Plus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '../ui/alert-dialog';
export const projectKey = (userId: string) => ['user', userId, 'canvas-projects'] as const;
export function ProjectDirectory({
  userId,
  selected,
  choose,
}: {
  userId: string;
  selected?: string;
  choose: (id: string) => void;
}) {
  const { t } = useLocale();
  const client = useQueryClient();
  const projects = useQuery({
    queryKey: projectKey(userId),
    queryFn: () => request<{ items: ScenarioInstance[] }>('/scenarios?kind=canvas'),
    enabled: !!userId,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [rename, setRename] = useState<ScenarioInstance>(),
    [title, setTitle] = useState(''),
    [dialogError, setDialogError] = useState(''),
    [deleting, setDeleting] = useState<ScenarioInstance>();
  const attempt = useRef<string | undefined>(undefined);
  const refresh = () => client.invalidateQueries({ queryKey: projectKey(userId) });
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <Button
        variant="outline"
        className="justify-start"
        disabled={!userId || busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          attempt.current ??= crypto.randomUUID();
          try {
            const project = await request<ScenarioInstance>('/scenarios', {
              method: 'POST',
              body: JSON.stringify({ kind: 'canvas', requestId: attempt.current }),
            });
            attempt.current = undefined;
            await refresh();
            choose(project.id);
          } catch (e) {
            setError(workspaceError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Plus />
        {busy ? t('正在创建…') : attempt.current ? t('重试创建项目') : t('新建创作项目')}
      </Button>
      {(error || projects.error) && (
        <p role="alert" className="text-xs text-destructive">
          {t(error || workspaceError(projects.error))}
        </p>
      )}
      <ScrollArea className="-mx-4 min-h-0 flex-1">
        <nav className="space-y-1 px-4" aria-label={t('创作项目')}>
          {projects.data?.items.map((project) => {
            const displayTitle =
              project.titleCustom === false && project.title === '未命名创作'
                ? t('未命名创作')
                : project.title;
            return (
              <div
                className="flex items-center rounded-md has-[button[aria-current=page]]:bg-accent"
                key={project.id}
              >
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start"
                  aria-current={project.id === selected ? 'page' : undefined}
                  onClick={() => choose(project.id)}
                >
                  <span className="truncate">{displayTitle}</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('项目操作：{title}', { title: displayTitle })}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem
                      onSelect={() => {
                        setDialogError('');
                        setRename(project);
                        setTitle(displayTitle);
                      }}
                    >
                      <Pencil />
                      {t('重命名项目')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setDialogError('');
                        setDeleting(project);
                      }}
                    >
                      <Trash2 />
                      {t('删除项目')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
          {!projects.isPending && !projects.data?.items.length && (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              {t('新建项目，整理你的创作方向。')}
            </p>
          )}
        </nav>
      </ScrollArea>
      <Dialog
        open={!!rename}
        onOpenChange={(open) => {
          if (!open) setRename(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('重命名项目')}</DialogTitle>
            <DialogDescription>{t('主画布和聊天将保留。')}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!rename) return;
              setBusy(true);
              setDialogError('');
              try {
                await request(`/scenarios/${rename.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ title }),
                });
                await refresh();
                await client.invalidateQueries({
                  queryKey: ['user', userId, 'scenario', rename.id],
                });
                setRename(undefined);
              } catch (e) {
                setDialogError(workspaceError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Label htmlFor="project-name">{t('项目名称')}</Label>
            <Input
              id="project-name"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              aria-invalid={!!dialogError}
              aria-describedby={dialogError ? 'project-dialog-error' : undefined}
            />
            {dialogError && (
              <Alert variant="destructive" id="project-dialog-error">
                <AlertDescription>{t(dialogError)}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={busy || !title.trim()}>
              {t('保存')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('删除创作项目？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('将删除项目画布、主聊天和项目内素材，无法恢复。')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialogError && (
            <Alert variant="destructive">
              <AlertDescription>{t(dialogError)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={async (event) => {
                event.preventDefault();
                if (!deleting) return;
                setBusy(true);
                setDialogError('');
                try {
                  await request(`/scenarios/${deleting.id}`, { method: 'DELETE' });
                  if (selected === deleting.id) choose('');
                  await refresh();
                  setDeleting(undefined);
                } catch (e) {
                  setDialogError(workspaceError(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('删除项目')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

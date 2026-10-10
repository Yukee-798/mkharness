import { useState } from 'react';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { request, ApiError } from './api';
import { usePanelDrafts } from './PanelDrafts';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Alert, AlertDescription } from './ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from './ui/alert-dialog';

export function ConversationActions({
  id,
  title,
  onRenamed,
  onDeleted,
}: {
  id: string;
  title: string;
  onRenamed: (title: string) => void;
  onDeleted: () => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const drafts = usePanelDrafts();
  const deleted = () => {
    drafts.removeConversation(id);
    setDeleteOpen(false);
    onDeleted();
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await request(`/conversations/${id}`, { method: 'DELETE' });
      deleted();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) deleted();
      else setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="聊天操作"
            className="mr-1 shrink-0 md:opacity-0 md:group-hover/chat:opacity-100 md:group-focus-within/chat:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setName(title);
              setError('');
              setRenameOpen(true);
            }}
          >
            <Pencil />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => {
              setError('');
              setDeleteOpen(true);
            }}
          >
            <Trash2 />
            删除聊天
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (!busy) setRenameOpen(open);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>重命名聊天</DialogTitle>
            <DialogDescription>为这段聊天设置一个方便查找的名称。</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!name.trim() || busy) return;
              setBusy(true);
              setError('');
              try {
                const renamed = await request<{ title: string }>(`/conversations/${id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ title: name.trim() }),
                });
                onRenamed(renamed.title);
                setRenameOpen(false);
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label htmlFor={`chat-name-${id}`} className="sr-only">
              聊天名称
            </label>
            <Input
              id={`chat-name-${id}`}
              value={name}
              maxLength={120}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => event.target.select()}
            />
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setRenameOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? '保存中…' : '保存名称'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!busy) setDeleteOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除聊天？</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              “{title}”的历史和面板输入将被删除，当前任务会停止，排队任务会撤回。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {busy ? '正在停止并删除…' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

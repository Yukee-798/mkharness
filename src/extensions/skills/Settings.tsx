import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, FileUp, Plus, Trash2 } from 'lucide-react';
import { request } from '../../browser/api';
import { useLocale } from '../../browser/app/locale';
import { Button } from '../../browser/ui/button';
import { Input } from '../../browser/ui/input';
import { Checkbox } from '../../browser/ui/checkbox';
import { Badge } from '../../browser/ui/badge';
import { Label } from '../../browser/ui/label';
import { Alert, AlertDescription } from '../../browser/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../browser/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '../../browser/ui/alert-dialog';
import { skillQuery, skillQueryKey } from './queries';
import type { SkillView, SkillPreview } from '../../shared/skills';

export function Skills({ userId }: { userId: string }) {
  const { t } = useLocale(),
    client = useQueryClient();
  const query = useQuery(skillQuery(userId));
  const [importing, setImporting] = useState<{ target?: SkillView }>(),
    [preview, setPreview] = useState<SkillPreview>(),
    [file, setFile] = useState<File>();
  const [viewing, setViewing] = useState<SkillPreview>(),
    [remove, setRemove] = useState<SkillView>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const inFlight = useRef(false);
  async function perform(work: () => Promise<void>, refresh = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
      if (refresh) await client.invalidateQueries({ queryKey: skillQueryKey(userId) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function closeImport() {
    setImporting(undefined);
    setPreview(undefined);
    setFile(undefined);
  }
  return (
    <section className="space-y-5 py-2" aria-label={t('Skills')}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <h2 className="font-medium">{t('Skills')}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              'Import task guidance and reference files. Enabled skills are available in new chats; existing chats keep their versions.',
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            closeImport();
            setImporting({});
          }}
        >
          <Plus />
          {t('Import skill')}
        </Button>
      </div>
      {(error || query.error) && (
        <Alert variant="destructive">
          <AlertDescription>{t(error || query.error?.message || '')}</AlertDescription>
        </Alert>
      )}
      {query.isPending && <p role="status">{t('Loading skills…')}</p>}
      {importing && (
        <div className="space-y-4 rounded-xl border p-4" aria-label={t('Import skill')}>
          <p className="text-sm font-medium">
            {importing.target
              ? `${t('Update skill')}: ${importing.target.name}`
              : t('Import skill')}
          </p>
          <Input
            type="file"
            aria-label={t('Skill file')}
            accept=".md,.zip"
            disabled={busy}
            onChange={(e) => {
              const candidate = e.target.files?.[0];
              setFile(candidate);
              setPreview(undefined);
              if (candidate)
                void perform(async () => {
                  const result = await request<{ preview: SkillPreview }>(
                    `/skills/preview?filename=${encodeURIComponent(candidate.name)}`,
                    {
                      method: 'POST',
                      body: candidate,
                      headers: { 'Content-Type': 'application/octet-stream' },
                    },
                  );
                  setPreview(result.preview);
                });
            }}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              'Upload SKILL.md or a ZIP containing one skill. Scripts are not executed. Skills do not grant tool permissions.',
            )}
          </p>
          {preview && <Preview preview={preview} />}
          <div className="flex gap-2">
            <Button
              disabled={busy || !preview || !file}
              onClick={() =>
                void perform(async () => {
                  if (!file) return;
                  const target = importing.target;
                  await request(
                    `/skills${target ? `/${target.id}/versions` : ''}?filename=${encodeURIComponent(file.name)}`,
                    {
                      method: 'POST',
                      body: file,
                      headers: {
                        'Content-Type': 'application/octet-stream',
                        ...(target ? { 'If-Match': String(target.revision) } : {}),
                      },
                    },
                  );
                  closeImport();
                }, true)
              }
            >
              {t(importing.target ? 'Save new version' : 'Save skill')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={closeImport}>
              {t('Cancel')}
            </Button>
          </div>
        </div>
      )}
      {query.isSuccess && !query.data.skills.length && !importing && (
        <p className="text-sm text-muted-foreground">{t('No skills yet.')}</p>
      )}
      {query.data?.skills.map((skill) => (
        <div key={skill.id} className="space-y-3 rounded-xl border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h3 className="break-words text-sm font-medium">{skill.name}</h3>
              <p className="text-sm text-muted-foreground">{skill.description}</p>
            </div>
            <Badge variant="secondary" title={skill.version}>
              {skill.version.slice(0, 8)}
            </Badge>
          </div>
          {skill.warnings.map((warning) => (
            <p key={warning} className="text-xs text-muted-foreground">
              {t(warning)}
            </p>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Label className="font-normal">
              <Checkbox
                checked={skill.enabled}
                disabled={busy}
                onCheckedChange={(value) =>
                  void perform(async () => {
                    await request(`/skills/${skill.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ revision: skill.revision, enabled: value === true }),
                    });
                  }, true)
                }
              />
              {t('Enabled')}
            </Label>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const result = await request<{ preview: SkillPreview }>(`/skills/${skill.id}`);
                  setViewing(result.preview);
                })
              }
            >
              <BookOpen />
              {t('View skill')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                closeImport();
                setImporting({ target: skill });
              }}
            >
              <FileUp />
              {t('Update skill')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={`${t('Delete skill')} ${skill.name}`}
              onClick={() => setRemove(skill)}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
      <Dialog
        open={!!viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(undefined);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewing?.name}</DialogTitle>
            <DialogDescription>{t('Skill instructions and bundled files')}</DialogDescription>
          </DialogHeader>
          {viewing && <Preview preview={viewing} />}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open) setRemove(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Delete skill')} {remove?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Remove this skill from your library. Existing chats retain their pinned versions and loaded instructions.',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = remove;
                setRemove(undefined);
                if (target)
                  void perform(async () => {
                    await request(`/skills/${target.id}`, {
                      method: 'DELETE',
                      body: JSON.stringify({ revision: target.revision }),
                    });
                  }, true);
              }}
            >
              {t('Delete skill')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
function Preview({ preview }: { preview: SkillPreview }) {
  const { t } = useLocale();
  return (
    <div className="space-y-3" data-slot="skill-preview">
      <div>
        <p className="text-sm font-medium">{preview.name}</p>
        <p className="text-sm text-muted-foreground">{preview.description}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('Version')}: {preview.version.slice(0, 12)}
        </p>
      </div>
      {preview.compatibility && (
        <p className="text-xs">
          {t('Compatibility')}: {preview.compatibility}
        </p>
      )}
      {preview.allowedTools && (
        <p className="text-xs">
          {t('Declared tools')}: {preview.allowedTools}
        </p>
      )}
      {preview.warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          {t(warning)}
        </p>
      ))}
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
        {preview.body}
      </pre>
      <ul className="max-h-40 overflow-y-auto text-xs text-muted-foreground">
        {preview.files.map((f) => (
          <li key={f.path} className="break-all py-1">
            {f.path} · {f.size} B{f.kind === 'script' ? ` · ${t('Not executable')}` : ''}
            {f.encoding === 'base64' ? ` · ${t('Binary asset')}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useLocale } from '../../browser/app/locale';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { connect, PortMessenger, type Connection } from 'penpal';
import { Download, RotateCcw, X } from 'lucide-react';
import { Button } from '../../browser/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../browser/ui/select';
import { Alert, AlertDescription } from '../../browser/ui/alert';
import { useWorkspace } from '../../browser/workspace/provider';
import { workspaceError } from '../../browser/workspace/error';
import { renderReport, reportRuntimeMessages } from './template';
import { reportBridge } from './sandbox';
import { assetURL, type WorkspaceObject } from '../../shared/workspace';
import type { ReportRevision } from '../../server/workspace/documents';

type ReportData = ReportRevision & { object: WorkspaceObject; revision: number };
export default function ReportView() {
  const { t, locale } = useLocale();
  const w = useWorkspace()!;
  const reports = w.snapshot?.objects.filter((o) => o.type === 'report') ?? [];
  const [selection, setSelection] = useState<{ id: string; revision: number }>(),
    [error, setError] = useState('');
  const report = reports.find((r) => r.id === w.activeObjectId) ?? reports.at(-1);
  const revision = selection?.id === report?.id ? selection?.revision : undefined;
  const setRevision = (value?: number) =>
    setSelection(
      value && value !== Number(report?.data.revision) && report
        ? { id: report.id, revision: value }
        : undefined,
    );
  useEffect(() => {
    setSelection(undefined);
    setError('');
  }, [report?.id]);
  const data = useQuery({
    queryKey: ['user', w.instance?.id, 'report', report?.id, report?.contentVersion, revision],
    queryFn: () =>
      w.read<ReportData>('report', { id: report!.id, ...(revision ? { revision } : {}) }),
    enabled: !!report,
  });
  if (!report)
    return (
      <div className="m-auto p-8 text-center text-sm text-muted-foreground">
        {t('向 Agent 描述你需要的报告，生成后会显示在这里。')}
      </div>
    );
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('HTML 报告工作区')}>
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b p-2">
        <Select
          value={report.id}
          onValueChange={(id) => {
            w.openObject(id);
            setRevision(undefined);
          }}
        >
          <SelectTrigger
            aria-label={t('切换报告')}
            className="h-8 min-w-0 flex-1 text-left"
            title={report.title}
          >
            <SelectValue>{report.title}</SelectValue>
          </SelectTrigger>
          <SelectContent className="w-[min(28rem,calc(100vw-1rem))]">
            {reports.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                <span className="line-clamp-2 break-words whitespace-normal" title={r.title}>
                  {r.title}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(revision ?? Number(report.data.revision))}
          onValueChange={(value) => setRevision(Number(value))}
        >
          <SelectTrigger aria-label={t('报告版本')} className="h-8 w-18 shrink-0 px-2">
            <SelectValue>v{revision ?? Number(report.data.revision)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: Number(report.data.revision) }, (_, i) => i + 1)
              .reverse()
              .map((v) => (
                <SelectItem key={v} value={String(v)}>
                  v{v}
                  {v === Number(report.data.revision) ? ` · ${t('当前')}` : ''}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {revision && revision !== Number(report.data.revision) && (
          <Button
            variant="outline"
            size="icon-sm"
            title={t('恢复为新版本')}
            aria-label={t('恢复为新版本')}
            disabled={w.busy}
            onClick={() =>
              void w
                .execute(
                  'report.restore',
                  { id: report.id, revision },
                  { [report.id]: report.version },
                )
                .then(() => setRevision(undefined))
                .catch(() => {})
            }
          >
            <RotateCcw />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('下载 HTML')}
          aria-label={t('下载 HTML')}
          onClick={async () => {
            setError('');
            try {
              const response = await fetch(
                `/api/scenarios/${encodeURIComponent(w.instance!.id)}/reports/${encodeURIComponent(report.id)}/export?locale=${locale}${revision ? `&revision=${revision}` : ''}`,
              );
              if (!response.ok) throw new Error('报告导出失败，请检查图片素材后重试');
              const url = URL.createObjectURL(await response.blob()),
                link = document.createElement('a');
              link.href = url;
              link.download = `${report.title.replace(/[/\\:*?"<>|]/g, '_')}.html`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (e) {
              setError(workspaceError(e));
            }
          }}
        >
          <Download />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('关闭报告工作区')}
          onClick={() => w.setOpen(false)}
        >
          <X />
        </Button>
      </div>
      {!w.connected && (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground" role="status">
          {t('正在恢复工作区连接…')}
        </p>
      )}
      {(error || data.error) && (
        <Alert variant="destructive">
          <AlertDescription>{t(error || workspaceError(data.error))}</AlertDescription>
        </Alert>
      )}
      {data.data ? (
        <ReportFrame key={`${report.id}:${data.data.revision}`} data={data.data} />
      ) : (
        <p className="p-4 text-sm">{t('正在读取报告…')}</p>
      )}
    </section>
  );
}
function ReportFrame({ data }: { data: ReportData }) {
  const { t, locale } = useLocale();
  const w = useWorkspace()!,
    iframe = useRef<HTMLIFrameElement>(null),
    connection = useRef<Connection<{ setDependencyError: (message: string) => void }> | undefined>(
      undefined,
    );
  const runtimeMessages = useRef(reportRuntimeMessages[locale]);
  runtimeMessages.current = reportRuntimeMessages[locale];
  const [documentSource, setDocumentSource] = useState(''),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false);
  const token = useMemo(() => crypto.randomUUID(), []),
    scope = `${w.instance!.id}:${data.object.id}:${data.revision}:${token}`;
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const urls: string[] = [];
    const prepare = async () => {
      let source = data.source;
      const ids = [
        ...new Set([...source.matchAll(/workspace-asset:([a-zA-Z0-9:_-]+)/g)].map((m) => m[1])),
      ];
      for (const id of ids) {
        const response = await fetch(assetURL(w.instance!.id, id), { signal: controller.signal });
        if (!response.ok) throw new Error('报告引用的图片无法读取');
        const url = URL.createObjectURL(await response.blob());
        urls.push(url);
        source = source.replaceAll(`workspace-asset:${id}`, url);
      }
      if (!disposed)
        setDocumentSource(
          renderReport(
            source,
            { id: data.template, dependencies: data.dependencies, styles: data.styles },
            reportBridge(scope),
            runtimeMessages.current,
          ),
        );
    };
    void prepare().catch((e) => {
      if (!disposed) setError(workspaceError(e));
    });
    return () => {
      disposed = true;
      controller.abort();
      connection.current?.destroy();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [data, scope, w.instance]);
  useEffect(() => {
    // Update host-owned copy without reloading the report or losing chart interactions.
    const current = connection.current;
    if (!current) return;
    void current.promise
      .then((remote) => {
        if (connection.current === current)
          return remote.setDependencyError(reportRuntimeMessages[locale].dependencyError);
      })
      .catch(() => {});
  }, [locale, ready]);
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!ready) setError('报告连接或依赖加载超时，请重新打开。');
    }, 20000);
    return () => clearTimeout(timeout);
  }, [ready]);
  const onLoad = () => {
    const frame = iframe.current?.contentWindow;
    if (!frame || !documentSource) return;
    connection.current?.destroy();
    const channel = new MessageChannel();
    const active = () => connection.current === current;
    const current = connect<{ setDependencyError: (message: string) => void }>({
      messenger: new PortMessenger({ port: channel.port1 }),
      timeout: 10000,
      methods: {
        ready(value: unknown) {
          if (active() && valid(value)) {
            setReady(true);
            setError('');
          }
        },
        error(value: unknown) {
          if (active() && valid(value)) setError('报告脚本或资源执行失败，可在聊天中请求修复。');
        },
      },
    });
    function valid(value: unknown): boolean {
      return !!value && typeof value === 'object' && 'token' in value && value.token === scope;
    }
    connection.current = current;
    void current.promise.catch(() => {
      if (active()) setError('报告通信失败，请重新打开。');
    });
    frame.postMessage({ kind: 'report:connect', token: scope }, '*', [channel.port2]);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <Alert variant="destructive" className="m-2 w-auto">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
      {!ready && !error && (
        <span className="px-3 py-1 text-xs text-muted-foreground" role="status">
          {t('正在启动报告预览…')}
        </span>
      )}
      {documentSource && (
        <iframe
          ref={iframe}
          title={data.object.title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={documentSource}
          onLoad={onLoad}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}

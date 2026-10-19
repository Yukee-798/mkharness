import { useLocale } from '../../browser/app/locale';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../../browser/ui/collapsible';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  applyNodeChanges,
  useReactFlow,
  type Node,
  type NodeProps,
  type NodeChange,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Download,
  Expand,
  ImagePlus,
  Layers,
  Minus,
  Plus,
  Redo2,
  Star,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useWorkspace } from '../../browser/workspace/provider';
import { workspaceError } from '../../browser/workspace/error';
import { useComposerDraft } from '../../browser/workbench/composer-drafts';
import { Button } from '../../browser/ui/button';
import { ImageViewer } from '../../browser/ui/image-viewer';
import { Input } from '../../browser/ui/input';
import { Textarea } from '../../browser/ui/textarea';
import { Label } from '../../browser/ui/label';
import { Alert, AlertDescription } from '../../browser/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../browser/ui/dialog';
import { ScrollArea } from '../../browser/ui/scroll-area';
import { assetURL, type WorkspaceObject, type WorkspaceAsset } from '../../shared/workspace';
import { NativeSelect, NativeSelectOption } from '../../browser/ui/native-select';

type CanvasNode = Node<
  { object: WorkspaceObject; scenarioId: string; asset?: WorkspaceAsset; status?: string },
  'creative'
>;
const nodeTypes = { creative: CreativeNode };
function CreativeNode({ data, selected }: NodeProps<CanvasNode>) {
  const { t } = useLocale();
  const [preview, setPreview] = useState(false);
  return (
    <div
      className={`w-60 overflow-hidden rounded-xl border bg-background shadow-sm ${selected ? 'ring-2 ring-primary' : 'border-border'}`}
    >
      <Handle type="target" position={Position.Left} className="opacity-0!" />
      <Handle type="source" position={Position.Right} className="opacity-0!" />
      <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
        <span className="min-w-0 flex-1 truncate">{data.object.title}</span>
        {data.object.data.selected === true && (
          <Star className="size-4 fill-amber-400 text-amber-500" />
        )}
      </div>
      {data.asset ? (
        <div className="relative bg-muted/20">
          <img
            className="h-44 w-full object-contain"
            src={assetURL(data.scenarioId, data.asset.id)}
            alt={data.object.title}
            draggable={false}
          />
          <div className="nodrag absolute right-2 top-2 flex gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              className="bg-white/30 text-black/70 hover:bg-white/90"
              aria-label={t('放大 {title}', { title: data.object.title })}
              onClick={() => setPreview(true)}
            >
              <Expand />
            </Button>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="bg-white/30 text-black/70 hover:bg-white/90"
            >
              <a
                href={assetURL(data.scenarioId, data.asset.id, true)}
                download
                aria-label={t('下载 {title}', { title: data.object.title })}
              >
                <Download />
              </a>
            </Button>
          </div>
        </div>
      ) : (
        <div className="min-h-28 p-3 text-sm whitespace-pre-wrap text-muted-foreground">
          {data.object.data.kind === 'pending'
            ? ['failed', 'blocked'].includes(data.status ?? '')
              ? t('生成未完成，请查看任务状态。')
              : t('正在生成图片…')
            : data.object.data.kind === 'failed'
              ? t('生成未完成：{error}', {
                  error: t(String(data.object.data.error ?? 'image_generation_failed')),
                })
              : String(data.object.data.text ?? '') || t('文字节点')}
        </div>
      )}
      {data.object.data.group && (
        <div className="border-t bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
          {t('组 · {name}', { name: String(data.object.data.group) })}
        </div>
      )}
      {data.asset && (
        <ImageViewer
          open={preview}
          onOpenChange={setPreview}
          src={assetURL(data.scenarioId, data.asset.id)}
          title={data.object.title}
          download={
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-white/85 hover:bg-white/15 hover:text-white"
            >
              <a
                href={assetURL(data.scenarioId, data.asset.id, true)}
                download
                aria-label={t('下载原图')}
                title={t('下载原图')}
              >
                <Download />
              </a>
            </Button>
          }
        />
      )}
    </div>
  );
}
export default function CanvasView() {
  return (
    <ReactFlowProvider>
      <CreativeCanvas />
    </ReactFlowProvider>
  );
}
function CreativeCanvas() {
  const { t, locale } = useLocale();
  const w = useWorkspace()!,
    flow = useReactFlow<CanvasNode>();
  const snapshot = w.snapshot;
  const [nodes, setNodes] = useState<CanvasNode[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [assets, setAssets] = useState(false),
    [adding, setAdding] = useState<'text' | 'image' | null>(null);
  const [title, setTitle] = useState(''),
    [addError, setAddError] = useState(''),
    [text, setText] = useState(''),
    [ratio, setRatio] = useState('1:1'),
    [nodeTitle, setNodeTitle] = useState(''),
    [nodeText, setNodeText] = useState('');
  const draft = useComposerDraft(w.instance?.mainChatId ?? '');
  const dragging = useRef(new Set<string>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const business = snapshot?.objects.filter((o) => o.type === 'canvas.node') ?? [];
  const active = business.find((o) => o.id === selected[0]);
  useEffect(() => {
    if (!snapshot || !w.instance) return;
    setNodes((previous) =>
      snapshot.objects
        .filter((o) => o.type === 'canvas.node')
        .map((object) => ({
          ...previous.find((node) => node.id === object.id),
          id: object.id,
          type: 'creative',
          position: dragging.current.has(object.id)
            ? (previous.find((node) => node.id === object.id)?.position ??
              (object.data.position as { x: number; y: number }))
            : (object.data.position as { x: number; y: number }),
          selected: selectedRef.current.includes(object.id),
          data: {
            object,
            scenarioId: w.instance!.id,
            asset: snapshot.assets.find((asset) => asset.id === object.data.assetId),
            status: snapshot.operations.find((op) => op.nodeId === object.id)?.status,
          },
        })),
    );
  }, [snapshot, w.instance]);
  useEffect(() => {
    setNodeTitle(active?.title ?? '');
    setNodeText(String(active?.data.text ?? ''));
  }, [active?.id, active?.contentVersion, active?.title, active?.data.text]);
  const edges = useMemo<Edge[]>(
    () =>
      (snapshot?.objects ?? [])
        .filter(
          (o) =>
            o.type === 'canvas.node' &&
            typeof o.data.parentId === 'string' &&
            snapshot?.objects.some((parent) => parent.id === o.data.parentId),
        )
        .map((o) => ({
          id: `derived:${o.id}`,
          source: String(o.data.parentId),
          target: o.id,
          type: 'smoothstep',
          label: t('派生'),
          selectable: false,
        })),
    [snapshot, t],
  );
  const mutate = (name: string, input: Parameters<typeof w.execute>[1], ids: string[] = []) =>
    w
      .execute(
        name,
        input,
        Object.fromEntries(ids.map((id) => [id, business.find((o) => o.id === id)!.version])),
      )
      .catch(() => {});
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) =>
      setNodes((previous) =>
        applyNodeChanges(
          changes.filter((c) => c.type !== 'remove'),
          previous,
        ),
      ),
    [],
  );
  const savePositions = (_event: unknown, _node: CanvasNode, moved: CanvasNode[]) => {
    const values = moved.length ? moved : [_node];
    dragging.current.clear();
    void mutate(
      'canvas.update',
      {
        ids: values.map((n) => n.id),
        positions: Object.fromEntries(values.map((n) => [n.id, n.position])),
      },
      values.map((n) => n.id),
    );
  };
  const refer = () => {
    if (!active) return;
    w.select(
      selected
        .map((id) => business.find((o) => o.id === id)!)
        .filter(Boolean)
        .map((o) => ({ objectId: o.id, contentVersion: o.contentVersion })),
    );
    w.setOpen(true);
    draft.edit(
      t('基于选中的「{title}」方向继续探索，生成新的候选，保留原图。', { title: active.title }),
    );
  };
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('创作画布')}>
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setTitle('');
            setText('');
            setAddError('');
            setAdding('text');
          }}
        >
          <Type />
          {t('文字')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setTitle('');
            setText('');
            setAddError('');
            setAdding('image');
          }}
        >
          <ImagePlus />
          {t('生成图片')}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('撤销')}
          aria-label={t('撤销')}
          disabled={w.busy || !snapshot?.canUndo}
          onClick={() => void mutate('workspace.undo', {})}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('重做')}
          aria-label={t('重做')}
          disabled={w.busy || !snapshot?.canRedo}
          onClick={() => void mutate('workspace.redo', {})}
        >
          <Redo2 />
        </Button>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {w.connected ? t('已连接') : t('连接恢复中')}
        </span>
        <Button
          variant={assets ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={assets}
          onClick={() => setAssets(!assets)}
        >
          <Layers />
          {t('素材 {count}', { count: snapshot?.assets.length ?? 0 })}
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlow<CanvasNode>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStart={(_event, node, moved) => {
              dragging.current = new Set((moved.length ? moved : [node]).map((n) => n.id));
            }}
            onSelectionDragStart={(_event, moved) => {
              dragging.current = new Set(moved.map((n) => n.id));
            }}
            onNodeDragStop={savePositions}
            onSelectionDragStop={(event, moved) => savePositions(event, moved[0], moved)}
            onSelectionChange={({ nodes: chosen }) => {
              const ids = chosen.map((n) => n.id);
              if (ids.join(',') === selectedRef.current.join(',')) return;
              setSelected(ids);
              selectedRef.current = ids;
              w.select(
                chosen.map((n) => ({
                  objectId: n.id,
                  contentVersion: n.data.object.contentVersion,
                })),
              );
            }}
            ariaLabelConfig={{
              'node.a11yDescription.default': t(
                '使用方向键移动节点，按 Enter 或空格选择，按 Escape 取消。',
              ),
              'node.a11yDescription.keyboardDisabled': t(
                '按 Enter 或空格选择节点，按 Escape 取消。',
              ),
              'node.a11yDescription.ariaLiveMessage': ({ x, y }) =>
                t('节点已移动到 x {x}、y {y}。', { x, y }),
              'edge.a11yDescription.default': t('按 Enter 或空格选择连线，按 Escape 取消。'),
              'controls.ariaLabel': t('画布操作'),
              'controls.zoomIn.ariaLabel': t('放大'),
              'controls.zoomOut.ariaLabel': t('缩小'),
              'controls.fitView.ariaLabel': t('适应画布'),
              'controls.interactive.ariaLabel': t('切换画布交互'),
              'minimap.ariaLabel': t('画布缩略图'),
              'handle.ariaLabel': t('连接点'),
            }}
            nodesConnectable={false}
            deleteKeyCode={null}
            fitView
            minZoom={0.15}
            maxZoom={2}
            selectionOnDrag
            panOnDrag={[1, 2]}
            preventScrolling
            aria-label={t('创作节点画布')}
          >
            <Background gap={24} size={1} />
          </ReactFlow>
          {!business.length && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-10 text-center text-sm text-muted-foreground">
              {t('添加灵感文字，或在右侧让 Agent 生成几个图片方向。')}
            </div>
          )}
          <div className="absolute bottom-3 left-3 flex gap-1 rounded-lg border bg-background p-1 shadow-sm">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('缩小')}
              onClick={() => void flow.zoomOut()}
            >
              <ZoomOut />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('放大')}
              onClick={() => void flow.zoomIn()}
            >
              <ZoomIn />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('适应画布')}
              onClick={() => void flow.fitView({ padding: 0.2 })}
            >
              <Expand />
            </Button>
          </div>
          {!!selected.length && (
            <div className="absolute right-3 bottom-3 left-40 flex flex-wrap justify-end gap-1">
              <Button
                variant="secondary"
                size="sm"
                disabled={w.busy}
                onClick={() =>
                  void mutate(
                    'canvas.update',
                    { ids: selected, selected: !active?.data.selected },
                    selected,
                  )
                }
              >
                <Star />
                {t('选定方向')}
              </Button>
              {selected.length > 1 && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={w.busy}
                  onClick={() =>
                    void mutate(
                      'canvas.update',
                      {
                        ids: selected,
                        group: t('方向组 {time}', { time: new Date().toLocaleTimeString(locale) }),
                      },
                      selected,
                    )
                  }
                >
                  <Layers />
                  {t('分组')}
                </Button>
              )}
              {!!active?.data.group && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={w.busy}
                  onClick={() =>
                    void mutate('canvas.update', { ids: selected, group: '' }, selected)
                  }
                >
                  <Minus />
                  {t('取消分组')}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={refer}>
                {t('继续探索')}
              </Button>
              <Button
                variant="destructive"
                size="icon-sm"
                aria-label={t('删除选中节点')}
                disabled={w.busy}
                onClick={() => void mutate('canvas.remove', { ids: selected }, selected)}
              >
                <Trash2 />
              </Button>
            </div>
          )}
        </div>
        {assets && (
          <aside
            className="flex w-60 shrink-0 flex-col border-l bg-background"
            aria-label={t('素材列表')}
          >
            <h2 className="p-3 text-sm font-medium">{t('项目素材')}</h2>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3 p-3">
                {snapshot?.assets.map((asset) => (
                  <div key={asset.id} className="space-y-2 rounded-lg border p-2">
                    <img
                      src={assetURL(w.instance!.id, asset.id)}
                      alt={asset.title}
                      className="h-28 w-full object-contain"
                    />
                    <p className="truncate text-xs">{asset.title}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={w.busy}
                      onClick={() =>
                        void mutate('canvas.add', {
                          title: asset.title,
                          assetId: asset.id,
                          position: { x: 50 + business.length * 30, y: 50 },
                        })
                      }
                    >
                      <Plus />
                      {t('放入画布')}
                    </Button>
                  </div>
                ))}
                {!snapshot?.assets.length && (
                  <p className="text-xs text-muted-foreground">
                    {t('生成的原始素材会保留在这里。')}
                  </p>
                )}
              </div>
            </ScrollArea>
          </aside>
        )}
      </div>
      {active && (
        <form
          className="flex flex-wrap items-end gap-2 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              'canvas.update',
              {
                ids: [active.id],
                title: nodeTitle,
                ...(active.data.kind === 'text' ? { text: nodeText } : {}),
              },
              [active.id],
            );
          }}
        >
          <div className="min-w-28 flex-1">
            <Label htmlFor="node-title">{t('节点名称')}</Label>
            <Input
              id="node-title"
              value={nodeTitle}
              onChange={(e) => setNodeTitle(e.target.value)}
            />
          </div>
          {active.data.kind === 'text' && (
            <div className="min-w-40 flex-1">
              <Label htmlFor="node-text">{t('文字内容')}</Label>
              <Input
                id="node-text"
                value={nodeText}
                onChange={(e) => setNodeText(e.target.value)}
              />
            </div>
          )}
          <Button type="submit" variant="outline" size="sm" disabled={w.busy || !nodeTitle.trim()}>
            {t('保存')}
          </Button>
        </form>
      )}
      {!!snapshot?.operations.some((op) => ['failed', 'blocked'].includes(op.status)) && (
        <Collapsible className="border-t px-3 py-2 text-xs text-destructive">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              {t('有图片任务未完成')}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {snapshot.operations
              .filter((op) => ['failed', 'blocked'].includes(op.status))
              .map((op) => (
                <p key={op.id}>
                  {t(op.code ?? '任务已停止或无法恢复')} · {op.id}
                </p>
              ))}
          </CollapsibleContent>
        </Collapsible>
      )}
      <Dialog
        open={!!adding}
        onOpenChange={(open) => {
          if (!open) setAdding(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{adding === 'image' ? t('生成图片') : t('添加文字节点')}</DialogTitle>
            <DialogDescription>
              {adding === 'image'
                ? t('提交一个文生图任务，生成期间可继续整理画布。')
                : t('保存灵感、说明或创作方向。')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (w.busy || (addError && w.retry)) return;
              setAddError('');
              const position = flow.screenToFlowPosition({ x: innerWidth / 2, y: innerHeight / 2 });
              void w
                .execute(
                  adding === 'image' ? 'canvas.generate' : 'canvas.add',
                  adding === 'image'
                    ? { title, prompt: text, aspectRatio: ratio, resolution: '1K', position }
                    : { title, text, position },
                )
                .then(() => setAdding(null))
                .catch((error) => setAddError(workspaceError(error)));
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="creative-title">{t('名称')}</Label>
              <Input
                id="creative-title"
                value={title}
                maxLength={100}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="creative-prompt">
                {adding === 'image' ? t('图片描述') : t('文字内容')}
              </Label>
              <Textarea
                id="creative-prompt"
                value={text}
                maxLength={10000}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            {adding === 'image' && (
              <NativeSelect
                aria-label={t('图片比例')}
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
              >
                {['1:1', '16:9', '9:16', '4:3', '3:4'].map((r) => (
                  <NativeSelectOption key={r}>{r}</NativeSelectOption>
                ))}
              </NativeSelect>
            )}
            <Button
              type="submit"
              disabled={
                w.busy ||
                !!(addError && w.retry) ||
                !title.trim() ||
                (adding === 'image' && !text.trim())
              }
            >
              {w.busy ? t('正在提交…') : t('创建')}
            </Button>
            {addError && (
              <Alert variant="destructive">
                <AlertDescription>
                  {t(addError)}
                  {w.retry && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={w.busy}
                      onClick={() => {
                        void w.retry!()
                          .then(() => setAdding(null))
                          .catch((error) => setAddError(workspaceError(error)));
                      }}
                    >
                      {t('重试同一操作')}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

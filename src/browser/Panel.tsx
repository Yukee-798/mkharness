import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Renderer, type ActionEvent } from '@openuidev/react-lang';
import { library, PanelContext, type PanelGuard } from '../shared/catalog';
import type { Program, Json } from '../shared/compute';
import { finiteJson, jsonEqual, canonicalJson } from '../shared/compute';
import type { RawState, RunCommand } from '../shared/contracts';
import { computeProgram } from './compute';
import { request } from './api';
import { type PanelDraft, type SaveStatus } from './draft';
import { usePanelDrafts } from './PanelDrafts';
import { Button } from './ui/button';
export type PanelBundle = {
  panelRef: string;
  ui: string;
  program: Program | null;
  state?: RawState;
  revision: number;
};
export function Panel({
  conversationId,
  panelRef,
  preview,
  submit,
}: {
  conversationId: string;
  panelRef?: string;
  preview?: string;
  submit: (text: string, source?: RunCommand['source']) => Promise<void>;
}) {
  const [bundle, setBundle] = useState<PanelBundle>(),
    [error, setError] = useState(''),
    [status, setStatus] = useState<SaveStatus>('saved'),
    [guardTick, setGuardTick] = useState(0);
  const [draft, setDraft] = useState<PanelDraft>();
  const drafts = usePanelDrafts();
  const state = useRef<RawState>({}),
    epoch = useRef(0),
    userEvent = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!panelRef) return;
    const controller = new AbortController();
    void request<PanelBundle>(
      `/conversations/${conversationId}/panels/${encodeURIComponent(panelRef)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        const entry = drafts.open(
          `${conversationId}/${panelRef}`,
          value.state ?? {},
          value.revision,
          async (raw, revision) => {
            const result = await request<{ revision: number }>(
              `/conversations/${conversationId}/panels/${encodeURIComponent(panelRef)}/state`,
              { method: 'PATCH', body: JSON.stringify({ state: raw, expectedRevision: revision }) },
            );
            return result.revision;
          },
        );
        state.current = entry.saver.current();
        setDraft(entry);
        setBundle({ ...value, state: state.current });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [conversationId, panelRef, drafts]);
  const saver = draft?.saver;
  useEffect(() => draft?.subscribe(setStatus), [draft]);
  const guard = useMemo<PanelGuard>(
    () => ({ epoch: 0, ready: !bundle?.program, halted: false, report: setError }),
    [bundle],
  );
  const tools = useMemo(() => {
    if (!bundle?.program) return undefined;
    let live = true,
      failed = false;
    const active = new Set<symbol>(),
      provenance = new WeakMap<object, string>();
    guard.isCurrent = (frame: unknown) => {
      if (!frame || typeof frame !== 'object') return false;
      const f = frame as { result: unknown; inputs: unknown };
      try {
        return (
          !!f.result &&
          typeof f.result === 'object' &&
          provenance.get(f.result) === canonicalJson(f.inputs)
        );
      } catch {
        return false;
      }
    };
    const notify = () => {
      if (live) {
        guard.ready = active.size === 0 && !failed;
        setGuardTick((n) => n + 1);
      }
    };
    const provider = {
      run_program: async (inputs: Record<string, unknown>) => {
        finiteJson(inputs);
        const token = Symbol(),
          startedEpoch = guard.epoch;
        active.add(token);
        failed = false;
        guard.ready = false;
        try {
          const result = await computeProgram(bundle.program!, inputs as Json);
          if (!live || startedEpoch !== guard.epoch) throw new Error('Stale computation discarded');
          if (!result.ok) {
            failed = true;
            setError(result.error.message);
            throw new Error(result.error.message);
          }
          if (result.value && typeof result.value === 'object')
            provenance.set(result.value, canonicalJson(inputs));
          return result.value;
        } finally {
          active.delete(token);
          notify();
        }
      },
    };
    return {
      provider,
      ready: () => active.size === 0 && !failed,
      resetError: () => {
        failed = false;
      },
      activate: () => {
        live = true;
      },
      dispose: () => {
        live = false;
        guard.ready = false;
      },
    };
  }, [bundle, guard]);
  useEffect(() => {
    tools?.activate();
    return () => tools?.dispose();
  }, [tools]);
  const markUserCommit = useCallback(() => {
    userEvent.current = false;
    guard.epoch = ++epoch.current;
    guard.halted = false;
    tools?.resetError();
    if (mounted.current) setError('');
  }, [guard, tools]);
  const change = useCallback(
    (raw: Record<string, unknown>) => {
      try {
        finiteJson(raw);
        if (userEvent.current && !jsonEqual(raw, state.current)) markUserCommit();
        state.current = raw as RawState;
        guard.ready = !bundle?.program || !!tools?.ready();
        if (mounted.current) setGuardTick((n) => n + 1);
        saver?.update(state.current);
      } catch {
        if (mounted.current) setError('Input state cannot be saved as finite JSON');
      }
    },
    [saver, guard, bundle, tools, markUserCommit],
  );
  guard.markUserCommit = markUserCommit;
  guard.captureBinding = (key, value) => change({ ...state.current, [key]: value });
  const act = useCallback(
    (event: ActionEvent) => {
      if (!bundle) return;
      if (event.type !== 'continue_conversation') {
        setError('This action is not available in this application');
        return;
      }
      void submit(event.humanFriendlyMessage || 'Analyze the current inputs', {
        panelRef: bundle.panelRef,
        action: 'continue_analysis',
        state: structuredClone({ ...state.current, ...event.formState }),
      }).catch((e) => setError(e.message));
    },
    [bundle, submit],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- The tick invalidates context after mutable guard fields change.
  const context = useMemo(() => Object.create(guard) as PanelGuard, [guard, guardTick]);
  // Immediate native controls use capture; delayed Slider commits mark their own boundary.
  const edit = () => {
    userEvent.current = true;
    setTimeout(() => {
      userEvent.current = false;
    }, 0);
  };
  return (
    <section
      className="generated-panel -mx-1 min-w-0 max-w-[calc(100%+0.5rem)] overflow-x-auto p-1 whitespace-normal"
      aria-label="Interactive answer"
      onChangeCapture={edit}
      onClickCapture={edit}
      onKeyDownCapture={edit}
    >
      <div inert={!bundle || undefined}>
        <PanelContext value={context}>
          <RenderBoundary key={bundle ? 'committed' : 'preview'}>
            <Renderer
              response={bundle?.ui ?? preview ?? null}
              library={library}
              isStreaming={!bundle}
              initialState={bundle?.state}
              onStateUpdate={bundle ? change : undefined}
              onAction={bundle ? act : undefined}
              onError={(errors) => {
                if (bundle && errors.length) setError(errors.map((e) => e.message).join('; '));
              }}
              toolProvider={tools?.provider}
              publishObservability={false}
            />
          </RenderBoundary>
        </PanelContext>
      </div>
      {bundle && (status === 'error' || status === 'conflict') && (
        <p className="save-status mt-3 text-xs leading-relaxed text-muted-foreground" role="status">
          {status === 'conflict'
            ? '另一页面已更新；当前草稿已保留，整页刷新前请先复制改动'
            : '保存失败，当前改动仍保留'}
        </p>
      )}
      {status === 'error' && <Button onClick={() => saver?.retry()}>重试保存</Button>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
class RenderBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : '内容暂时无法显示' };
  }
  render() {
    return this.state.error ? (
      <p role="alert">内容暂时无法显示：{this.state.error}。可继续发送消息，填写内容仍保留。</p>
    ) : (
      this.props.children
    );
  }
}

import { ThemeProvider } from '@openuidev/react-ui';
import { openUITheme } from './theme';
import '@openuidev/react-ui/index.css';
import './styles.css';
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
import { library, PanelContext, type PanelGuard } from './catalog';
import type { Program, Json } from '../../shared/compute';
import { finiteJson, jsonEqual, canonicalJson } from '../../shared/compute';
import type { RawState, RunCommand } from '../../shared/contracts';
import { actionParams, externalURL, UI_ACTIONS } from './contracts';
import { computeProgram } from '../../browser/compute';
import { request } from '../../browser/api';
import { type ResourceDraft, type SaveStatus } from '../../browser/draft';
import { useResourceDrafts } from '../../browser/ResourceDrafts';
import { Button } from '../../browser/ui/button';
export type PanelBundle = {
  panelRef: string;
  ui: string;
  program: Program | null;
  state?: RawState;
  revision: number;
};
export function Panel({
  conversationId,
  userId = '',
  panelRef,
  preview,
  submit,
}: {
  conversationId: string;
  userId?: string;
  panelRef?: string;
  preview?: string;
  submit: (text: string, source?: RunCommand['source']) => Promise<void>;
}) {
  const [bundle, setBundle] = useState<PanelBundle>(),
    [error, setError] = useState(''),
    [status, setStatus] = useState<SaveStatus>('saved'),
    [guardTick, setGuardTick] = useState(0);
  const [draft, setDraft] = useState<ResourceDraft>();
  const drafts = useResourceDrafts();
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
    void request<{
      ref: string;
      data: Pick<PanelBundle, 'ui' | 'program'>;
      state: RawState;
      revision: number;
    }>(
      `/conversations/${conversationId}/extensions/openui/resources/${encodeURIComponent(panelRef)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        const entry = drafts.open(
          [userId, conversationId, 'openui', panelRef],
          value.state ?? {},
          value.revision,
          async (raw, revision) => {
            const result = await request<{ revision: number }>(
              `/conversations/${conversationId}/extensions/openui/resources/${encodeURIComponent(panelRef)}/state`,
              { method: 'PATCH', body: JSON.stringify({ state: raw, expectedRevision: revision }) },
            );
            return result.revision;
          },
        );
        state.current = entry.saver.current();
        setDraft(entry);
        setBundle({
          ...value.data,
          panelRef: value.ref,
          revision: value.revision,
          state: state.current,
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [userId, conversationId, panelRef, drafts]);
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
    const active = new Set<AbortController>(),
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
        const controller = new AbortController(),
          startedEpoch = guard.epoch;
        active.add(controller);
        failed = false;
        guard.ready = false;
        try {
          const result = await computeProgram(bundle.program!, inputs as Json, controller.signal);
          if (!live || controller.signal.aborted || startedEpoch !== guard.epoch)
            throw new Error('Stale computation discarded');
          if (!result.ok) {
            failed = true;
            setError(result.error.message);
            throw new Error(result.error.message);
          }
          if (result.value && typeof result.value === 'object')
            provenance.set(result.value, canonicalJson(inputs));
          return result.value;
        } finally {
          active.delete(controller);
          notify();
        }
      },
    };
    return {
      provider,
      ready: () => active.size === 0 && !failed,
      invalidate: () => {
        for (const controller of active) controller.abort();
        failed = false;
      },
      activate: () => {
        live = true;
      },
      dispose: () => {
        live = false;
        for (const controller of active) controller.abort();
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
    tools?.invalidate();
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
      if (event.type === UI_ACTIONS.link) {
        try {
          const url = externalURL(event.params?.url);
          // Keep navigation in the original user gesture, before any asynchronous work.
          window.open(url, '_blank', 'noopener,noreferrer');
          setError('');
        } catch (error) {
          setError(error instanceof Error ? error.message : '链接暂时无法打开。');
        }
        return;
      }
      if (event.type !== UI_ACTIONS.assistant) {
        setError('此操作暂不可用，请继续发送消息。');
        return;
      }
      try {
        const params = actionParams(event.params);
        const inputs = structuredClone({ ...state.current, ...event.formState });
        finiteJson(inputs);
        void submit(event.humanFriendlyMessage || 'Analyze the current inputs', {
          action: 'extension_action',
          extensionId: 'openui',
          name: 'continue',
          payload: {
            ref: bundle.panelRef,
            state: inputs,
            ...(Object.keys(params).length ? { params } : {}),
          },
        }).catch((e) => setError(e.message));
        setError('');
      } catch (error) {
        setError(error instanceof Error ? error.message : '此操作暂不可用，请继续发送消息。');
      }
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
    <ThemeProvider lightTheme={openUITheme}>
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
          <p
            className="save-status mt-3 text-xs leading-relaxed text-muted-foreground"
            role="status"
          >
            {status === 'conflict'
              ? '另一页面已更新；当前草稿已保留，整页刷新前请先复制改动'
              : '保存失败，当前改动仍保留'}
          </p>
        )}
        {status === 'error' && <Button onClick={() => saver?.retry()}>重试保存</Button>}
        {error && <p role="alert">{error}</p>}
      </section>
    </ThemeProvider>
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

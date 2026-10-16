import { ThemeProvider } from '@openuidev/react-ui';
import { openUITheme } from './theme';
import '@openuidev/react-ui/index.css';
import './styles.css';
import {
  Component,
  useEffect,
  useMemo,
  useSyncExternalStore,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Renderer, type ActionEvent } from '@openuidev/react-lang';
import { library, PanelContext } from './catalog';
import type { Program } from './compute/contracts';
import type { RawState, RunCommand } from '../../shared/contracts';
import { actionParams, externalURL, UI_ACTIONS } from './contracts';
import { computeProgram } from './compute/browser';
import { request } from '../../browser/api';
import { type ResourceDraft, type SaveStatus } from '../../browser/extensions/draft';
import { useResourceDrafts } from '../../browser/extensions/ResourceDrafts';
import { Button } from '../../browser/ui/button';
import { inputState } from './state';
import { PanelSession } from './panel/session';
import { useLocale } from '../../browser/app/locale';
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
  const { t } = useLocale();
  const [bundle, setBundle] = useState<PanelBundle>(),
    [error, setError] = useState(''),
    [status, setStatus] = useState<SaveStatus>('saved');
  const [draft, setDraft] = useState<ResourceDraft>();
  const drafts = useResourceDrafts();
  const userEvent = useRef(false),
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
          () =>
            request<{ state: RawState; revision: number }>(
              `/conversations/${conversationId}/extensions/openui/resources/${encodeURIComponent(panelRef)}`,
            ),
        );
        setDraft(entry);
        setBundle({
          ...value.data,
          panelRef: value.ref,
          revision: value.revision,
          state: entry.saver.current(),
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [userId, conversationId, panelRef, drafts]);
  const saver = draft?.saver;
  useEffect(() => draft?.subscribe(setStatus), [draft]);
  const session = useMemo(
    () =>
      new PanelSession({
        program: bundle?.program,
        initialState: bundle?.state,
        compute: computeProgram,
        save: saver,
        report: (message) => {
          if (mounted.current) setError(message);
        },
        userCommitted: () => {
          userEvent.current = false;
        },
      }),
    [bundle, saver],
  );
  useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const provider = useMemo(
    () => (bundle?.program ? { run_program: session.run } : undefined),
    [bundle, session],
  );
  const change = (raw: Record<string, unknown>) => session.change(raw, userEvent.current);
  const act = (event: ActionEvent) => {
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
      const inputs = inputState({ ...session.current(), ...event.formState });
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
  };
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
        aria-label={t('Interactive answer')}
        onChangeCapture={edit}
        onClickCapture={edit}
        onKeyDownCapture={edit}
      >
        <div inert={!bundle || undefined}>
          <PanelContext value={session}>
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
                toolProvider={provider}
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
            {t(
              status === 'conflict'
                ? '另一页面已更新；当前草稿已保留，整页刷新前请先复制改动'
                : '保存失败，当前改动仍保留',
            )}
          </p>
        )}
        {status === 'error' && <Button onClick={() => saver?.retry()}>{t('重试保存')}</Button>}
        {error && <p role="alert">{t(error)}</p>}
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
    return this.state.error ? <RenderError error={this.state.error} /> : this.props.children;
  }
}
function RenderError({ error }: { error: string }) {
  const { t } = useLocale();
  return <p role="alert">{t('显示失败说明', { error })}</p>;
}

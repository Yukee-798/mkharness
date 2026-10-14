import { useLocale } from '../../browser/locale';
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactElement,
} from 'react';
import {
  createLibrary,
  defineComponent,
  reactive,
  useStateField,
  useIsQueryLoading,
  useIsStreaming,
  useGetFieldValue,
  isReactiveAssign,
} from '@openuidev/react-lang';
// Share the root export with ThemeProvider; the genui-lib bundle has a separate context.
import { openuiLibrary } from '@openuidev/react-ui';
import { z } from 'zod';
import { finiteJson, jsonEqual } from '../../shared/compute';
import { validateSlider } from './slider';
export type PanelGuard = {
  epoch: number;
  ready: boolean;
  halted: boolean;
  isCurrent?: (frame: unknown) => boolean;
  markUserCommit?: () => void;
  captureBinding?: (key: string, value: unknown) => void;
  report: (message: string) => void;
};
export const PanelContext = createContext<PanelGuard | null>(null);
export const StateSync = defineComponent({
  name: 'StateSync',
  description:
    'Write next into a single declared reactive binding when enabled and current computation is ready. For program-backed writes, computed must be {result: the full Query result, inputs: the same current arguments used by Query}; the result must be an object. Maximum three automatic writes per user editing chain.',
  props: z.object({
    value: reactive(z.unknown()),
    next: z.unknown(),
    enabled: z.boolean(),
    computed: z.object({ result: z.unknown(), inputs: z.unknown() }).optional(),
  }),
  component: function StateSyncView({ props }) {
    const guard = useContext(PanelContext),
      { value, setValue } = useStateField('StateSync', props.value),
      streaming = useIsStreaming(),
      loading = useIsQueryLoading();
    const chain = useRef({ epoch: -1, writes: 0, halted: false });
    useEffect(() => {
      if (!guard) return;
      if (chain.current.epoch !== guard.epoch)
        chain.current = { epoch: guard.epoch, writes: 0, halted: false };
      if (!props.enabled || streaming || loading || !guard.ready || chain.current.halted) return;
      if (guard.isCurrent && !guard.isCurrent(props.computed)) return;
      try {
        finiteJson(props.next);
      } catch {
        guard.report('Automatic update is not finite JSON');
        return;
      }
      if (value !== undefined && jsonEqual(value, props.next)) return;
      if (chain.current.writes >= 3) {
        chain.current.halted = true;
        guard.halted = true;
        guard.report('Automatic input updates did not converge. Edit an input to retry.');
        return;
      }
      chain.current.writes++;
      setValue(props.next);
    }, [guard, value, setValue, props.next, props.enabled, props.computed, streaming, loading]);
    return null;
  },
});
const NativeSlider = openuiLibrary.components.Slider!;
const Slider = defineComponent({
  name: 'Slider',
  description:
    NativeSlider.description + '; finite min < max, positive step, at most 256 discrete options.',
  props: NativeSlider.props,
  component: function SliderView(args) {
    const { t } = useLocale();
    const guard = useContext(PanelContext),
      streaming = useIsStreaming(),
      getFieldValue = useGetFieldValue();
    // Validate before the native control allocates its select items/dots. Its
    // native hooks and rendering remain intact; only the actual commit is wrapped.
    const element = NativeSlider.component(args) as ReactElement<{
      defaultValue?: number[];
      onValueCommit: (values: number[]) => void;
    }>;
    try {
      validateSlider(args.props);
    } catch (error) {
      if (streaming) return <span>{t('Slider 正在生成…')}</span>;
      throw error;
    }
    return cloneElement(element, {
      onValueCommit: (values) => {
        if (
          element.props.defaultValue === undefined ||
          !jsonEqual(values, element.props.defaultValue)
        )
          guard?.markUserCommit?.();
        element.props.onValueCommit(values);
        // Native Slider flushes its debounce on unmount, after Renderer unsubscribes.
        // Read the committed reactive binding through the public field getter so its
        // transformed value still reaches the draft saver, without accessing a store.
        if (isReactiveAssign(args.props.value))
          guard?.captureBinding?.(
            args.props.value.target,
            getFieldValue(undefined, args.props.value.target),
          );
      },
    });
  },
});
export const library = createLibrary({
  root: openuiLibrary.root,
  components: [
    ...Object.values(openuiLibrary.components).filter((component) => component.name !== 'Slider'),
    Slider,
    StateSync,
  ],
});

import { cloneElement, createContext, useContext, useRef, type ReactElement } from 'react';
import { ACTION_STEPS, defineComponent, type ActionPlan } from '@openuidev/react-lang';
import { openuiLibrary, type ButtonProps } from '@openuidev/react-ui';
import { LoaderCircle } from 'lucide-react';
import { UI_ACTIONS } from './contracts';

export const ActionSubmissionContext = createContext<{
  pending: object | null;
  invoke: (button: object, sendsMessage: boolean, trigger: () => void) => void;
} | null>(null);

const NativeButton = openuiLibrary.components.Button!;
export const ActionButton = defineComponent({
  name: NativeButton.name,
  description: NativeButton.description,
  props: NativeButton.props,
  component: function ActionButtonView(args) {
    const submission = useContext(ActionSubmissionContext);
    const identity = useRef({});
    // Keep the SDK's validation, form snapshot and local Action steps intact.
    const element = NativeButton.component(args) as ReactElement<ButtonProps>;
    const action = args.props.action as ActionPlan | { type?: string } | undefined;
    const sendsMessage = !action
      ? true
      : 'steps' in action
        ? action.steps.some((step) => step.type === ACTION_STEPS.ToAssistant)
        : !action.type || action.type === UI_ACTIONS.assistant;
    const loading = submission?.pending === identity.current;
    return cloneElement(element, {
      disabled: element.props.disabled || (sendsMessage && !!submission?.pending),
      'aria-busy': loading || undefined,
      iconLeft: loading ? (
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      ) : (
        element.props.iconLeft
      ),
      onClick: (event) => {
        if (submission)
          submission.invoke(identity.current, sendsMessage, () => element.props.onClick?.(event));
        else element.props.onClick?.(event);
      },
    });
  },
});

import { defineComponent, useIsStreaming } from '@openuidev/react-lang';
import { z } from 'zod';
import { Progress as ProgressBar } from '../../browser/ui/progress';
import { validateProgress } from './progress';

export const Progress = defineComponent({
  name: 'Progress',
  description:
    'Read-only progress bar: value is between 0 and max (default 100), or null for unknown progress. Label describes the measured quantity; optional showValue defaults true. Bind value to a real input or computed result. Does not edit form state or track Agent tasks; never invent completion percentages.',
  props: z.object({
    value: z.number().nonnegative().nullable().optional(),
    label: z.string().min(1),
    max: z.number().positive().optional(),
    showValue: z.boolean().optional(),
  }),
  component: function ProgressView({ props }) {
    const streaming = useIsStreaming();
    try {
      validateProgress(props);
    } catch (error) {
      if (streaming) return null;
      throw error;
    }
    const max = props.max ?? 100;
    const value = props.value ?? null;
    return (
      <div className="w-full space-y-2">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>{props.label}</span>
          {value !== null && props.showValue !== false && (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {Math.round((value / max) * 100)}%
            </span>
          )}
        </div>
        <ProgressBar value={value} max={max} aria-label={props.label} />
      </div>
    );
  },
});

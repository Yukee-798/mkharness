import type { ComponentProps } from 'react';
import { Progress as ProgressPrimitive } from 'radix-ui';
import { cn } from './utils';

export function Progress({
  className,
  value,
  max = 100,
  ...props
}: ComponentProps<typeof ProgressPrimitive.Root>) {
  const percentage = value == null ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
      value={value}
      max={max}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          'h-full bg-primary transition-transform motion-reduce:transition-none',
          value == null ? 'w-1/3 motion-safe:animate-pulse' : 'w-full',
        )}
        style={value == null ? undefined : { transform: `translateX(-${100 - percentage}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

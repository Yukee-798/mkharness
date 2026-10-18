import * as ResizablePrimitive from 'react-resizable-panels';
import type { ComponentProps } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from './utils';

export function ResizablePanelGroup({
  className,
  ...props
}: ComponentProps<typeof ResizablePrimitive.Group>) {
  return (
    <ResizablePrimitive.Group
      className={cn('flex h-full w-full data-[orientation=vertical]:flex-col', className)}
      {...props}
    />
  );
}
export const ResizablePanel = ResizablePrimitive.Panel;
export function ResizableHandle({
  className,
  ...props
}: ComponentProps<typeof ResizablePrimitive.Separator>) {
  return (
    <ResizablePrimitive.Separator
      className={cn(
        'relative flex w-2 shrink-0 items-center justify-center bg-border/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        className,
      )}
      {...props}
    >
      <GripVertical className="size-3 text-muted-foreground" />
    </ResizablePrimitive.Separator>
  );
}

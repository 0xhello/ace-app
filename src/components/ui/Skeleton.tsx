import { cn } from "@/lib/utils";

/**
 * Skeleton — shimmering placeholder block for loading states.
 *
 * Use these to mirror the SHAPE of the real content while it loads, so a
 * slow fetch reads as intentional rather than a blank screen or a generic
 * spinner. Match the size/rounding of whatever it stands in for.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("ace-skeleton rounded-md", className)} aria-hidden />;
}

export default Skeleton;

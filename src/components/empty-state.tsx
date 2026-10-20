import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "dot-grid relative flex flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-border bg-card/45 text-center",
        compact ? "px-5 py-10" : "px-6 py-16",
        className,
      )}
    >
      <span className="mb-4 inline-flex size-12 items-center justify-center rounded-2xl border border-border/80 bg-card text-muted-foreground shadow-[0_1px_2px_oklch(0.2_0.02_255/5%)]">
        <Icon className="size-5" strokeWidth={1.7} />
      </span>
      <h3 className="text-balance font-display text-[15px] font-semibold tracking-tight text-foreground">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-lg text-balance text-[12.5px] leading-6 text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

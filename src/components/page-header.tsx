import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-7 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between", className)}>
      <div className="flex min-w-0 items-start gap-3.5">
        {Icon ? (
          <span className="mt-0.5 hidden size-11 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/[0.07] text-primary sm:inline-flex">
            <Icon className="size-5" strokeWidth={1.75} />
          </span>
        ) : null}
        <div className="min-w-0">
          <h1 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.025em] text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-[13px] leading-6 text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

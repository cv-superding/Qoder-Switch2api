import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type Tone = "brand" | "amber" | "rose" | "sky" | "neutral";

const TONES: Record<Tone, { icon: string; wash: string }> = {
  brand: { icon: "bg-primary/10 text-primary", wash: "oklch(0.62 0.13 162 / 7%)" },
  amber: { icon: "bg-amber-500/10 text-amber-600 dark:text-amber-400", wash: "oklch(0.8 0.12 78 / 8%)" },
  rose: { icon: "bg-rose-500/10 text-rose-600 dark:text-rose-400", wash: "oklch(0.7 0.13 22 / 7%)" },
  sky: { icon: "bg-sky-500/10 text-sky-600 dark:text-sky-400", wash: "oklch(0.68 0.1 235 / 7%)" },
  neutral: { icon: "bg-muted text-muted-foreground", wash: "oklch(0.6 0.02 255 / 4%)" },
};

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "brand",
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  className?: string;
}) {
  const theme = TONES[tone];
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/80 bg-card p-3.5 shadow-[0_1px_2px_oklch(0.2_0.02_255/4%)] sm:p-4",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-8 -top-10 size-28 rounded-full blur-2xl"
        style={{ background: theme.wash }}
      />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11.5px] font-medium tracking-[0.01em] text-muted-foreground">{label}</div>
          <div className="mt-2 font-display text-[22px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-foreground sm:text-[25px]">
            {value}
          </div>
          {hint ? <div className="mt-2 line-clamp-2 text-[10.5px] leading-4 text-muted-foreground sm:text-[11.5px]">{hint}</div> : null}
        </div>
        {Icon ? (
          <span className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-xl", theme.icon)}>
            <Icon className="size-4" strokeWidth={1.9} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

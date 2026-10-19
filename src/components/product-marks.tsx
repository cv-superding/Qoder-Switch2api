import { cn } from "@/lib/utils";

/** Qoder 品牌标识（内联 SVG，避免外部资源依赖） */

export function QoderMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cn("shrink-0", className)}
      role="img"
      aria-label="Qoder"
    >
      <rect width="32" height="32" rx="7" fill="#5b6cff" />
      <path
        d="M16 6.5a9.5 9.5 0 1 0 9.5 9.5h-4.2a5.3 5.3 0 1 1-5.3-5.3V6.5Z"
        fill="#fff"
      />
      <circle cx="22.4" cy="9.6" r="2.4" fill="#7ef0c0" />
    </svg>
  );
}

export function QoderCnMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cn("shrink-0", className)}
      role="img"
      aria-label="Qoder CN"
    >
      <rect width="32" height="32" rx="7" fill="#00a870" />
      <path
        d="M16 6.5a9.5 9.5 0 1 0 9.5 9.5h-4.2a5.3 5.3 0 1 1-5.3-5.3V6.5Z"
        fill="#fff"
      />
      <circle cx="22.4" cy="9.6" r="2.4" fill="#ffd666" />
    </svg>
  );
}

export function AppIconMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={cn("shrink-0", className)} role="img" aria-label="Qoder-Switch2api">
      <rect width="40" height="40" rx="9" fill="#101828" />
      <path d="M13 11a9 9 0 1 0 9 9h-4a5 5 0 1 1-5-5v-4Z" fill="#5b6cff" />
      <path d="M27 11a9 9 0 1 0 9 9h-4a5 5 0 1 1-5-5v-4Z" fill="#00a870" transform="translate(-4 8)" opacity="0.9" />
    </svg>
  );
}

export function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        on ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,.15)]" : "bg-muted-foreground/40",
      )}
      aria-hidden="true"
    />
  );
}

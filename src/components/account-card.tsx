import { useState } from "react";
import {
  ArrowLeftRight, Check, CircleCheck, Clock3, Coins, Ellipsis, Loader2, RefreshCw, Sparkles, Trash2, TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { QoderCnMark, QoderMark } from "@/components/product-marks";
import { cn } from "@/lib/utils";
import { accountGroupLabel, isInternational, type Account, type QuotaInfo } from "@/lib/types";

const AVATAR_TONES = [
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
] as const;

function avatarTone(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function formatCredits(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

/** 「上次设为当前」：当天只给时分，更早的带上月日 */
function formatSwitchedAt(ts: number | null | undefined): string {
  if (!ts) return "暂无记录";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "暂无记录";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `今天 ${time}`;
  const day = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  if (date.getFullYear() === now.getFullYear()) return `${day} ${time}`;
  return `${date.getFullYear()}-${day} ${time}`;
}

function formatQuotaUpdatedAt(ts: number | undefined | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function accountIdentity(account: Account): string {
  if (account.email) {
    const [local, domain] = account.email.split("@");
    if (!domain) return account.email;
    return `${local.slice(0, 1)}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
  }
  if (account.phone) return `${account.phone.slice(0, 3)}****${account.phone.slice(-4)}`;
  return account.uid ? `UID · ${account.uid}` : `ID · ${account.id}`;
}

const chipClass = "rounded-md px-1.5 py-0 text-[11px] font-medium";

interface Props {
  account: Account;
  compact?: boolean;
  credit?: QuotaInfo;
  creditLoading?: boolean;
  creditPriority?: boolean;
  clientActive?: boolean;
  clientBusy?: boolean;
  clientLoading?: boolean;
  onSwitch: (a: Account) => void;
  onDelete: (a: Account) => void;
  onRefresh: (a: Account) => void;
  onCheckin: (a: Account) => void;
  onSetGroup: (a: Account, group: string) => void;
  todayCheckedIn?: boolean;
}

export function AccountCard({
  account, compact = false, credit, creditLoading, creditPriority, clientActive, clientBusy, clientLoading,
  onSwitch, onDelete, onRefresh, onCheckin, onSetGroup, todayCheckedIn,
}: Props) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const intl = isInternational(account);
  const Mark = intl ? QoderMark : QoderCnMark;
  const displayName = account.name || account.email || account.phone || account.uid || "未命名账号";
  const quota = account.quota;
  const remaining = credit?.quota?.remaining ?? quota?.remaining ?? null;
  const total = credit?.quota?.total ?? quota?.total ?? null;
  const unit = credit?.quota?.unit || quota?.unit || "credits";
  const expiresAt = credit?.expiresAt ?? quota?.expiresAt ?? null;
  const updatedAt = credit?.quota ? undefined : quota?.updatedAt;
  const expired = typeof expiresAt === "number" && expiresAt < Date.now();
  const expiringSoon = typeof expiresAt === "number" && !expired && expiresAt - Date.now() < 7 * 86400000;

  // 百分比：优先由 remaining/total 计算；上游 percentage 可能是 0~1 小数，归一化到 0~100
  let percent: number | null = null;
  if (remaining != null && total) {
    percent = (remaining / total) * 100;
  } else if (typeof credit?.quota?.percentage === "number") {
    percent = credit.quota.percentage <= 1 ? credit.quota.percentage * 100 : credit.quota.percentage;
  }

  const tokenExpired =
    typeof account.tokenExpireAt === "number" && account.tokenExpireAt < Date.now();

  const statusChips = (
    <>
      {intl && (
        <Badge variant="secondary" className={cn(chipClass, "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300")}>
          国际版
        </Badge>
      )}
      {(account.group === "desktop" || account.group === "proxy") && (
        <Badge
          variant="secondary"
          className={cn(chipClass, account.group === "proxy" ? "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300" : "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300")}
        >
          {accountGroupLabel(account.group)}
        </Badge>
      )}
      {todayCheckedIn !== undefined && (
        <Badge variant={todayCheckedIn ? "success" : "secondary"} className={cn(chipClass, !todayCheckedIn && "text-muted-foreground")}>
          <CircleCheck /> {todayCheckedIn ? "已签到" : "未签到"}
        </Badge>
      )}
      {account.status === "needs_relogin" && (
        <Badge variant="warning" className={chipClass}>
          <TriangleAlert /> 需重新登录
        </Badge>
      )}
      {account.status !== "needs_relogin" && tokenExpired && (
        <Badge variant="warning" className={chipClass}>Token 已过期</Badge>
      )}
      {account.cooling && <Badge variant="secondary" className={cn(chipClass, "text-muted-foreground")}>冷却中</Badge>}
      {creditPriority && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="warning" className={cn(chipClass, "px-1")} aria-label="建议优先">
              <Sparkles className="size-3.5" />
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top">建议优先使用</TooltipContent>
        </Tooltip>
      )}
      {account.hasPat && <Badge variant="secondary" className={cn(chipClass, "text-muted-foreground")}>PAT</Badge>}
    </>
  );

  return (
    <TooltipProvider>
      <article className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,.025),0_10px_28px_rgba(15,23,42,.035)] transition-shadow hover:shadow-[0_2px_4px_rgba(15,23,42,.04),0_14px_34px_rgba(15,23,42,.055)]">
        <header
          className={cn(
            "relative flex items-center border-b border-border",
            compact ? "min-h-[52px] px-3.5 py-1.5" : "min-h-[104px] px-5 py-3",
            clientActive ? "bg-primary/5" : "bg-muted/30",
          )}
        >
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div
              className={cn(
                "absolute -right-10 -top-16 rounded-full blur-2xl",
                compact ? "size-20" : "size-24",
                clientActive ? "bg-primary/15" : "bg-muted/30",
              )}
            />
            <div className={cn("absolute top-[63%] -translate-y-1/2 opacity-[0.075] saturate-50 grayscale-[10%]", "right-5 rotate-[7deg]")}>
              <Mark size={compact ? 40 : 56} />
            </div>
          </div>

          <div className={cn("absolute z-20", compact ? "right-2.5 top-1/2 -translate-y-1/2" : "right-3.5 top-3.5")}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className={cn("rounded-lg text-muted-foreground hover:text-foreground", compact ? "size-7" : "size-8")} aria-label={`管理账号 ${displayName}`} title="更多账号操作">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem onSelect={() => onRefresh(account)}>
                  <RefreshCw />刷新 Token
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onCheckin(account)}>
                  <CircleCheck />手动签到
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {(["desktop", "proxy", ""] as const).map((g) => (
                  <DropdownMenuItem key={g || "ungrouped"} onSelect={() => onSetGroup(account, g)}>
                    {(account.group ?? "") === g ? <Check /> : <span className="inline-block size-4" />}
                    分组：{accountGroupLabel(g)}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:bg-destructive/5 focus:text-destructive" onSelect={() => setDeleteOpen(true)}>
                  <Trash2 />删除账号
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {compact ? (
            <div className="relative z-10 flex w-full min-w-0 items-center gap-2 pr-10">
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-5" title={displayName}>{displayName}</h3>
              <div className="hidden shrink-0 items-center gap-1 min-[420px]:flex">{statusChips}</div>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {clientActive ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="relative inline-flex size-7 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                        <Mark size={15} />
                        <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="size-2.5" strokeWidth={3} />
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">Qoder 客户端当前账号</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon" className="size-7 rounded-lg" disabled={clientBusy} onClick={() => onSwitch(account)} aria-label="设为 Qoder 客户端当前账号">
                        <Mark size={15} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="space-y-0.5">
                      <div>设为 Qoder 客户端当前账号（会重启客户端）</div>
                      <div className="text-muted-foreground">上次设为当前：{formatSwitchedAt(account.lastSwitchAt)}</div>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          ) : (
            <div className={cn("relative z-10 flex w-full min-w-0 items-center gap-3", "pr-10")}>
              <div className={cn("flex size-12 shrink-0 items-center justify-center rounded-full text-base font-semibold ring-4 ring-white/65 dark:ring-white/10", avatarTone(displayName))}>{displayName.charAt(0).toUpperCase()}</div>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold leading-5" title={displayName}>{displayName}</h3>
                <p className="mt-0.5 truncate text-xs leading-5 text-muted-foreground" title={account.email || account.uid || account.id}>{accountIdentity(account)}</p>
                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">{statusChips}</div>
              </div>
            </div>
          )}
        </header>

        <section className={cn("flex min-w-0 flex-1 flex-col", compact ? "px-3.5 pb-3 pt-3" : "px-5 pb-4 pt-4")}>
          {creditLoading ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />额度查询中…</div>
          ) : remaining == null ? (
            <div className="py-3 text-sm text-muted-foreground">等待额度数据…</div>
          ) : (
            <>
              <div className="flex items-baseline gap-x-3 gap-y-1">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="size-4 shrink-0 stroke-[1.75] text-muted-foreground" aria-hidden="true" />
                  <strong
                    className={cn("font-semibold leading-none tabular-nums tracking-[-0.025em]", compact ? "text-[20px]" : "text-[22px]")}
                    style={{ fontFamily: '"Bricolage Grotesque Variable", "SF Pro Display", ui-sans-serif, sans-serif' }}
                  >
                    {formatCredits(remaining)}
                  </strong>
                </span>
                <span className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>/ {formatCredits(total)} {unit}</span>
                <div className={cn("ml-auto flex items-center gap-1.5 text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
                  <Clock3 className="size-3.5 shrink-0" />
                  <span className="whitespace-nowrap tabular-nums">{updatedAt ? `${formatQuotaUpdatedAt(updatedAt)} 更新` : "—"}</span>
                </div>
              </div>

              <div className={cn("flex items-center justify-between", compact ? "mt-3" : "mt-4")}>
                <span className={cn("font-medium text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>剩余额度</span>
                <span className={cn("whitespace-nowrap tabular-nums", expired ? "text-destructive" : expiringSoon ? "text-orange-600 dark:text-orange-400" : "text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
                  {expiresAt ? `到期 ${new Date(expiresAt).toLocaleDateString("zh-CN")}` : "长期有效"}
                </span>
              </div>
              <div className={cn("h-1 overflow-hidden rounded-full bg-muted", compact ? "mt-1" : "mt-1.5")} aria-hidden="true">
                <div
                  className={cn("h-full rounded-full", expired ? "bg-destructive/60" : expiringSoon ? "bg-orange-500" : "bg-primary")}
                  style={{ width: `${Math.min(100, Math.max(2, percent ?? 0))}%` }}
                />
              </div>

              <div className={cn("text-muted-foreground", compact ? "mt-2 text-[11px]" : "mt-2 text-xs")}>切换于 {formatSwitchedAt(account.lastSwitchAt)}</div>
              {account.lastError && (
                <div className={cn("mt-1 min-w-0 truncate text-destructive", compact ? "text-[11px]" : "text-xs")} title={account.lastError}>
                  最近异常：{account.lastError}
                </div>
              )}
            </>
          )}
        </section>

        {!compact && (
          <footer className="flex flex-wrap items-center gap-2.5 border-t px-5 py-2.5">
            {clientActive ? (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 pr-3.5 text-xs font-medium text-primary">
                <Mark size={18} />
                <span>客户端当前</span>
              </span>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 pr-3.5 text-xs" disabled={clientBusy || clientLoading} onClick={() => onSwitch(account)} aria-label="切换到客户端" aria-busy={clientLoading}>
                    {clientLoading ? <Loader2 className="size-4 animate-spin" /> : <Mark size={18} />}
                    <span>{clientLoading ? "切换中…" : "切换到客户端"}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="space-y-0.5">
                  <div>切换为客户端登录账号（会重启 Qoder）</div>
                  <div className="text-muted-foreground">上次设为当前：{formatSwitchedAt(account.lastSwitchAt)}</div>
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 pr-3.5 text-xs" onClick={() => onRefresh(account)} aria-label="刷新 Token">
                  <RefreshCw className="size-4" /><span>刷新 Token</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">刷新登录令牌</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 pr-3.5 text-xs" onClick={() => onCheckin(account)} aria-label="手动签到">
                  <Coins className="size-4" /><span>签到</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">领取签到积分</TooltipContent>
            </Tooltip>
          </footer>
        )}
      </article>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除账号</DialogTitle>
            <DialogDescription>
              确定删除账号「{displayName}」？删除后不可恢复，客户端的登录态不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteOpen(false);
                onDelete(account);
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

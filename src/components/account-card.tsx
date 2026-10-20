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
  "from-emerald-400 to-teal-600",
  "from-sky-400 to-blue-600",
  "from-amber-400 to-orange-600",
  "from-rose-400 to-pink-600",
  "from-teal-400 to-cyan-600",
  "from-lime-400 to-emerald-600",
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

const chipClass = "h-[22px] px-2 text-[10.5px]";

interface Props {
  account: Account;
  compact?: boolean;
  credit?: QuotaInfo;
  creditLoading?: boolean;
  creditError?: string;
  clientActive?: boolean;
  clientBusy?: boolean;
  clientLoading?: boolean;
  onSwitch: (a: Account) => void;
  onDelete: (a: Account) => void;
  onRefresh: (a: Account) => void;
  onCheckin: (a: Account) => void;
  onRefreshCredit: (a: Account) => void;
  onSetGroup: (a: Account, group: string) => void;
  todayCheckedIn?: boolean;
}

export function AccountCard({
  account, compact = false, credit, creditLoading, creditError, clientActive, clientBusy, clientLoading,
  onSwitch, onDelete, onRefresh, onCheckin, onRefreshCredit, onSetGroup, todayCheckedIn,
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
  const updatedAt = quota?.updatedAt;
  const planPart = credit?.quota?.plan ?? quota?.plan ?? null;
  const addOnPart = credit?.quota?.addOn ?? quota?.addOn ?? null;
  const expired = typeof expiresAt === "number" && expiresAt < Date.now();
  const expiringSoon = typeof expiresAt === "number" && !expired && expiresAt - Date.now() < 7 * 86400000;
  const planTier = account.plan?.planTierName ?? "";

  let percent: number | null = null;
  if (remaining != null && total) {
    percent = (remaining / total) * 100;
  } else if (typeof credit?.quota?.percentage === "number") {
    // 上游 percentage 是「已用比例」，展示需要换算成剩余
    const used = credit.quota.percentage <= 1 ? credit.quota.percentage : credit.quota.percentage / 100;
    percent = (1 - used) * 100;
  }
  const clampedPercent = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  // 进度条表示剩余额度，不表示到期紧急程度；到期只通过右侧徽标提示
  const barTone = expired
    ? "bg-destructive/70"
    : percent == null
      ? "bg-primary"
      : clampedPercent <= 10
        ? "bg-destructive/70"
        : clampedPercent <= 30
          ? "bg-amber-500"
          : "bg-gradient-to-r from-primary/75 to-primary";

  const tokenExpired = typeof account.tokenExpireAt === "number" && account.tokenExpireAt < Date.now();
  const urgentChip =
    account.status === "needs_relogin" || tokenExpired ? "warning" : account.cooling ? "secondary" : null;
  const canSwitch = Boolean(account.hasToken);
  const canRefresh = Boolean(account.hasRefreshToken);
  const canCheckin = Boolean(account.hasToken || account.hasPat);

  const statusChips = (
    <>
      {intl && (
        <Badge variant="secondary" className={cn(chipClass, "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
          国际版
        </Badge>
      )}
      {(account.group === "desktop" || account.group === "proxy") && (
        <Badge variant="secondary" className={cn(chipClass, "text-muted-foreground")}>
          {accountGroupLabel(account.group)}
        </Badge>
      )}
      {planTier ? (
        <Badge variant="secondary" className={cn(chipClass, "text-muted-foreground")}>
          {planTier}
        </Badge>
      ) : null}
      {todayCheckedIn !== undefined && (
        <Badge
          variant={todayCheckedIn ? "success" : "secondary"}
          className={cn(chipClass, !todayCheckedIn && "text-muted-foreground")}
        >
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
      {account.cooling && !urgentChip && (
        <Badge variant="secondary" className={cn(chipClass, "text-muted-foreground")}>冷却中</Badge>
      )}
      {account.hasPat && <Badge variant="secondary" className={cn(chipClass, "text-muted-foreground")}>PAT</Badge>}
    </>
  );

  const moreMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("rounded-lg text-muted-foreground hover:text-foreground", compact ? "size-7" : "size-8")}
          aria-label={`管理账号 ${displayName}`}
          title="更多账号操作"
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="truncate">{displayName}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onRefresh(account)} disabled={!canRefresh}>
          <RefreshCw />刷新 Token
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCheckin(account)} disabled={!canCheckin}>
          <CircleCheck />手动签到
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>加入分组</DropdownMenuLabel>
        {(["proxy", "desktop", ""] as const).map((g) => (
          <DropdownMenuItem key={g || "ungrouped"} onSelect={() => onSetGroup(account, g)}>
            {(account.group ?? "") === g ? <Check /> : <span className="inline-block size-4" />}
            {accountGroupLabel(g)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/5 focus:text-destructive"
          onSelect={() => setDeleteOpen(true)}
        >
          <Trash2 />删除账号
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const quotaError = creditError ? (
    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-destructive">
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={creditError}>额度查询失败：{creditError}</span>
      <button
        type="button"
        onClick={() => onRefreshCredit(account)}
        className="shrink-0 rounded-md px-1.5 py-0.5 font-medium underline-offset-2 hover:underline"
      >
        重试
      </button>
    </div>
  ) : null;

  if (compact) {
    return (
      <TooltipProvider>
        <article
          className={cn(
            "group relative flex flex-col overflow-hidden rounded-xl border bg-card px-3.5 py-3 transition-colors",
            clientActive ? "border-primary/30 bg-primary/[0.025]" : "border-border/80 hover:border-border",
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={cn(
                "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-semibold text-white",
                avatarTone(displayName),
              )}
            >
              {displayName.charAt(0).toUpperCase()}
              {clientActive ? (
                <span className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border-2 border-card bg-primary text-primary-foreground">
                  <Check className="size-2" strokeWidth={3.5} />
                </span>
              ) : null}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h3 className="truncate text-[12.5px] font-semibold leading-5" title={displayName}>{displayName}</h3>
                {intl ? <QoderMark size={12} className="shrink-0 opacity-60" /> : null}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 truncate text-[10.5px] text-muted-foreground">
                <span className="truncate">{accountIdentity(account)}</span>
                {todayCheckedIn ? (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                    <CircleCheck className="size-3" />已签
                  </span>
                ) : null}
                {account.status === "needs_relogin" ? <span className="shrink-0 text-rose-600 dark:text-rose-400">需重登录</span> : null}
                {account.cooling ? <span className="shrink-0 text-amber-600 dark:text-amber-400">冷却中</span> : null}
              </div>
            </div>
            <div className="shrink-0 text-right">
              {creditLoading ? (
                <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <div className="font-display text-[15px] font-semibold leading-none tabular-nums">
                    {formatCredits(remaining)}
                  </div>
                  <div className="mt-0.5 text-[9.5px] text-muted-foreground">剩余 credits</div>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {!clientActive ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-lg"
                      disabled={clientBusy || !canSwitch}
                      onClick={() => onSwitch(account)}
                      aria-label="切换到客户端"
                      title={canSwitch ? "切换到 Qoder 客户端" : "该账号没有客户端登录 Token，无法切换"}
                    >
                      <ArrowLeftRight className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">切换到 Qoder 客户端</TooltipContent>
                </Tooltip>
              ) : null}
              {moreMenu}
            </div>
          </div>
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div
              className={cn("h-full rounded-full transition-[width]", barTone)}
              style={{ width: `${clampedPercent > 0 ? Math.max(2, clampedPercent) : 0}%` }}
            />
          </div>
          {quotaError}
        </article>

        <DeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen} name={displayName} onConfirm={() => onDelete(account)} />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <article
        className={cn(
          "card-lift relative flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-[0_1px_2px_oklch(0.2_0.02_255/4%)]",
          clientActive ? "border-primary/30" : "border-border/80",
        )}
      >
        {clientActive ? <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-primary/20 via-primary to-primary/20" /> : null}

        <header className="relative overflow-hidden px-5 pb-3.5 pt-4">
          <div className="pointer-events-none absolute -right-8 -top-12 size-32 rounded-full bg-primary/[0.035] blur-2xl" />
          <div className="relative flex items-start gap-3">
            <span
              className={cn(
                "relative flex size-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[15px] font-semibold text-white shadow-[inset_0_1px_0_oklch(1_0_0/25%)] ring-[3px] ring-card",
                avatarTone(displayName),
              )}
            >
              {displayName.charAt(0).toUpperCase()}
              {clientActive ? (
                <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-card bg-primary text-primary-foreground">
                  <Check className="size-2.5" strokeWidth={3.5} />
                </span>
              ) : null}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <h3 className="truncate text-[14px] font-semibold leading-5 tracking-[-0.01em]" title={displayName}>
                {displayName}
              </h3>
              <p className="mt-0.5 truncate text-[11.5px] leading-5 text-muted-foreground" title={account.email || account.uid || account.id}>
                {accountIdentity(account)}
              </p>
            </div>
            <div className="relative z-10 -mr-1 -mt-0.5 shrink-0">{moreMenu}</div>
          </div>
          <div className="relative mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5">{statusChips}</div>
        </header>

        <section className="flex min-w-0 flex flex-1 flex-col px-5 pb-4">
          {creditLoading ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />额度查询中
            </div>
          ) : remaining == null ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Sparkles className="size-3.5" />
              {creditError ? "额度暂不可用" : "等待额度数据"}
            </div>
          ) : (
            <>
              <div className="flex items-end justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="font-display text-[27px] font-semibold leading-none tracking-[-0.035em] tabular-nums">
                    {formatCredits(remaining)}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    / {formatCredits(total)} {unit}
                  </span>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium tabular-nums",
                    expired
                      ? "bg-destructive/10 text-destructive"
                      : expiringSoon
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-primary/8 text-primary",
                  )}
                >
                  {expired ? "已过期" : expiresAt ? `剩余 ${Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000))} 天` : "长期有效"}
                </span>
              </div>

              <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(clampedPercent)}
                aria-label="剩余额度"
              >
                <div
                  className={cn("h-full rounded-full transition-[width] duration-500", barTone)}
                  style={{ width: `${clampedPercent > 0 ? Math.max(2, clampedPercent) : 0}%` }}
                />
              </div>

              {addOnPart ? (
                <div
                  className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground"
                  title="总额度 = 套餐基础额度 + 赠送/签到额度"
                >
                  {planPart ? (
                    <span>基础 {formatCredits(planPart.remaining)} / {formatCredits(planPart.total)}</span>
                  ) : null}
                  <span>赠送 {formatCredits(addOnPart.remaining)} / {formatCredits(addOnPart.total)}</span>
                </div>
              ) : null}

              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10.5px] text-muted-foreground">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Clock3 className="size-3 shrink-0" />
                  <span className="truncate">{expiresAt ? `到期 ${new Date(expiresAt).toLocaleDateString("zh-CN")}` : "长期有效"}</span>
                </span>
                <span className="truncate text-right">{updatedAt ? `${formatQuotaUpdatedAt(updatedAt)} 更新` : "未更新"}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <ArrowLeftRight className="size-3 shrink-0" />
                  <span className="truncate">切换于 {formatSwitchedAt(account.lastSwitchAt)}</span>
                </span>
                <span className="truncate text-right">{percent != null ? `剩余 ${Math.round(clampedPercent)}%` : "占比未知"}</span>
              </div>
              {quotaError}
            </>
          )}
          {account.lastError && !creditError ? (
            <div className="mt-2 truncate text-[10.5px] text-destructive" title={account.lastError}>
              最近异常：{account.lastError}
            </div>
          ) : null}
        </section>

        <footer className="flex flex-wrap items-center gap-1.5 border-t border-border/70 bg-muted/20 px-3 py-2.5">
          {clientActive ? (
            <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/[0.06] px-2.5 text-[11.5px] font-medium text-primary">
              <Mark size={16} />
              客户端当前
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-primary/25 px-2.5 text-[11.5px] text-primary hover:bg-primary/[0.06] hover:text-primary"
              disabled={clientBusy || clientLoading || !canSwitch}
              onClick={() => onSwitch(account)}
              aria-label="切换到客户端"
              aria-busy={clientLoading}
              title={canSwitch ? "切换到 Qoder 客户端" : "该账号没有客户端登录 Token，无法切换"}
            >
              {clientLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Mark size={16} />}
              <span>{clientLoading ? "切换中" : "切换到客户端"}</span>
            </Button>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-lg"
                  onClick={() => onRefresh(account)}
                  disabled={!canRefresh}
                  aria-label="刷新 Token"
                  title={canRefresh ? "刷新登录令牌" : "没有 refresh token，需重新登录"}
                >
                  <RefreshCw className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">刷新登录令牌</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-lg"
                  onClick={() => onCheckin(account)}
                  disabled={!canCheckin}
                  aria-label="手动签到"
                  title={canCheckin ? "领取签到积分" : "账号没有登录凭证，无法签到"}
                >
                  <Coins className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">领取签到积分</TooltipContent>
            </Tooltip>
          </div>
        </footer>
      </article>

      <DeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen} name={displayName} onConfirm={() => onDelete(account)} />
    </TooltipProvider>
  );
}

function DeleteDialog({
  open, onOpenChange, name, onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>删除账号</DialogTitle>
          <DialogDescription>
            确定删除账号「{name}」？删除后不可恢复，Qoder 客户端的登录态不受影响。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

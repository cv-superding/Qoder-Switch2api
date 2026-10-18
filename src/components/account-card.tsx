import { useState } from "react";
import {
  ArrowLeftRight, Check, Coins, Copy, Ellipsis, Loader2, RefreshCw, Trash2, TriangleAlert,
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
import { accountGroupLabel, type Account, type QuotaInfo } from "@/lib/types";

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

function formatDate(ts: number | null | undefined): string {
  if (!ts) return "长期有效";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "暂无记录";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "暂无记录";
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function expiryClass(expiresAt: number | null | undefined): string {
  if (!expiresAt) return "text-muted-foreground";
  const days = (expiresAt - Date.now()) / 86400000;
  if (days < 0) return "text-destructive";
  if (days < 7) return "text-orange-600 dark:text-orange-400";
  return "text-muted-foreground";
}

function accountIdentity(account: Account): string {
  if (account.email) {
    const [local, domain] = account.email.split("@");
    if (!domain) return account.email;
    return `${local.slice(0, 1)}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
  }
  if (account.phone) return `${account.phone.slice(0, 3)}****${account.phone.slice(-4)}`;
  return account.uid ? `UID · ${account.uid.slice(0, 12)}…` : `ID · ${account.id}`;
}

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
  account, compact = true, credit, creditLoading, creditPriority, clientActive, clientBusy, clientLoading,
  onSwitch, onDelete, onRefresh, onCheckin, onSetGroup, todayCheckedIn,
}: Props) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const intl = account.edition === "international";
  const Mark = intl ? QoderMark : QoderCnMark;
  const displayName = account.name || account.email || account.phone || account.uid || "未命名账号";
  const quota = account.quota;
  const remaining = credit?.quota?.remaining ?? quota?.remaining ?? null;
  const total = credit?.quota?.total ?? quota?.total ?? null;
  const unit = credit?.quota?.unit || quota?.unit || "credits";
  const percent = credit?.quota?.percentage ?? (remaining != null && total ? (remaining / total) * 100 : null);

  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border bg-card p-4 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition-shadow hover:shadow-[0_4px_16px_rgba(15,23,42,.06)]",
        creditPriority && "ring-1 ring-orange-400/60",
        account.status === "needs_relogin" && "opacity-90",
      )}
    >
      {/* 头部 */}
      <div className="flex items-start gap-3">
        <span className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-[22%]", avatarTone(displayName))}>
          <span className="text-sm font-semibold">{displayName.slice(0, 2).toUpperCase()}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold" title={displayName}>{displayName}</span>
            {clientActive && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    <Check className="size-3" strokeWidth={2.5} />
                    当前
                  </span>
                </TooltipTrigger>
                <TooltipContent>该账号是 Qoder 客户端当前登录账号</TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground" title={accountIdentity(account)}>
            {accountIdentity(account)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className={cn("inline-flex rounded-[22%] p-[2px]", clientActive ? "bg-primary" : "bg-muted-foreground/30")}>
            <Mark size={compact ? 18 : 22} />
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 rounded-md" aria-label="更多操作">
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{displayName}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onRefresh(account)}>
                <RefreshCw /> 刷新 Token
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCheckin(account)}>
                <Coins /> 立即签到
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px]">账号分组</DropdownMenuLabel>
              {["", "desktop", "proxy"].map((g) => (
                <DropdownMenuItem key={g} onClick={() => onSetGroup(account, g)}>
                  {accountGroupLabel(g)}
                  {account.group === g && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 /> 删除账号
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* 状态行 */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {account.status === "needs_relogin" && (
          <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
            <TriangleAlert className="size-3" /> 需重新登录
          </Badge>
        )}
        {account.cooling && <Badge variant="warning" className="h-5 px-1.5 text-[10px]">冷却中</Badge>}
        {account.hasPat && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">PAT</Badge>}
        {!account.hasPat && account.hasToken && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">IDE 登录态</Badge>
        )}
        {todayCheckedIn && (
          <Badge variant="success" className="h-5 px-1.5 text-[10px]">
            <Check className="size-3" /> 已签到
          </Badge>
        )}
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal text-muted-foreground">
          {accountGroupLabel(account.group)}
        </Badge>
      </div>

      {/* 额度行 */}
      <div className="mt-3">
        {creditLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> 额度查询中…
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">剩余额度</span>
              <span className="font-semibold tabular-nums">
                {formatCredits(remaining)}
                <span className="ml-1 font-normal text-muted-foreground">/ {formatCredits(total)} {unit}</span>
              </span>
            </div>
            {percent != null && (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    percent < 10 ? "bg-destructive" : percent < 30 ? "bg-amber-500" : "bg-primary",
                  )}
                  style={{ width: `${Math.max(1, Math.min(100, percent))}%` }}
                />
              </div>
            )}
            <div className="flex items-center justify-between text-[11px]">
              <span className={expiryClass(credit?.expiresAt ?? quota?.expiresAt)}>
                到期 {formatDate(credit?.expiresAt ?? quota?.expiresAt)}
              </span>
              <span className="text-muted-foreground/70">切换于 {formatTime(account.lastSwitchAt)}</span>
            </div>
            {account.lastError && (
              <div className="truncate text-[11px] text-destructive" title={account.lastError}>
                {account.lastError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 操作区 */}
      <div className="mt-4 flex items-center gap-2 border-t border-border/60 pt-3">
        <Button
          size="sm"
          className="h-8 flex-1 bg-primary px-3 text-primary-foreground"
          disabled={clientBusy}
          onClick={() => onSwitch(account)}
        >
          {clientLoading ? <Loader2 className="animate-spin" /> : <ArrowLeftRight />}
          切换到客户端
        </Button>
        <TooltipProvider delayDuration={400}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 px-2.5" onClick={() => onRefresh(account)}>
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新 Token</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 px-2.5" onClick={() => onCheckin(account)}>
                <Coins />
              </Button>
            </TooltipTrigger>
            <TooltipContent>立即签到</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

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
    </div>
  );
}

export { Copy };

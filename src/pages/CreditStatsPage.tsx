import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Coins, Loader2, RefreshCw, Sparkles, TriangleAlert, Users, WalletCards } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Segmented } from "@/components/segmented";
import { StatCard } from "@/components/stat-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import * as api from "@/lib/api";
import { hasQuotaData, isPermanentExpiry, remainingPercent } from "@/lib/quota";
import type { Account, Edition, QuotaInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAccountsStore } from "@/stores/accounts";

function fmtDate(ts: number | null | undefined): string {
  if (isPermanentExpiry(ts)) return "长期有效";
  const d = new Date(ts as number);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysLeft(ts: number | null | undefined): number | null {
  if (isPermanentExpiry(ts)) return null;
  return Math.ceil((ts! - Date.now()) / 86400000);
}

function fmtNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function accountRemainingPercent(account: Account, credit: QuotaInfo | undefined): number | null {
  return remainingPercent(credit?.quota ?? account.quota);
}

/** 积分统计：各账号额度、到期、签到状态 */
export default function CreditStatsPage() {
  const {
    accounts, creditMap, creditLoadingMap, creditErrorMap, refreshingCredits, error, fetchAll, refreshCredits, ensureCredits,
  } = useAccountsStore();
  const [edition, setEdition] = useState<Edition>("domestic");
  const [checkinLogs, setCheckinLogs] = useState<Record<string, unknown>[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    void fetchAll();
    void loadLogs();
  }, [fetchAll]);

  useEffect(() => {
    if (accounts.length > 0) void ensureCredits(accounts.map((a) => a.id));
  }, [accounts, ensureCredits]);

  async function loadLogs() {
    setLogsLoading(true);
    try {
      const res = await api.api.getCheckinLogs();
      setCheckinLogs(res.logs ?? []);
    } catch {
      /* 签到日志不是关键数据 */
    } finally {
      setLogsLoading(false);
    }
  }

  const editionAccounts = useMemo(
    () => accounts.filter((a) => (a.edition === "international") === (edition === "international")),
    [accounts, edition],
  );

  async function onRefresh() {
    await refreshCredits(editionAccounts.map((a) => a.id));
    void loadLogs();
    toast.success("积分与签到记录已刷新");
  }

  const totalRemaining = editionAccounts.reduce((sum, a) => sum + (creditMap[a.id]?.quota?.remaining ?? a.quota?.remaining ?? 0), 0);
  const expiringSoon = editionAccounts.filter((a) => {
    const d = daysLeft(creditMap[a.id]?.expiresAt ?? a.quota?.expiresAt);
    return d != null && d >= 0 && d <= 7;
  }).length;
  const abnormal = editionAccounts.filter(
    (a) => a.status === "needs_relogin" || Boolean(creditErrorMap[a.id]),
  ).length;

  return (
    <div>
      <PageHeader
        icon={WalletCards}
        title="积分统计"
        description="查看各账号 Credits 额度、到期时间与最近的签到记录，数据来自 Qoder OpenAPI。"
        actions={
          <>
            <Segmented
              ariaLabel="账号版本"
              value={edition}
              onChange={setEdition}
              options={[
                { value: "domestic", label: "国内版", count: accounts.filter((a) => a.edition === "domestic").length },
                { value: "international", label: "国际版", count: accounts.filter((a) => a.edition === "international").length },
              ]}
            />
            <Button variant="ghost" size="icon" className="size-9" onClick={() => void onRefresh()} disabled={refreshingCredits} aria-label="刷新积分">
              <RefreshCw className={cn(refreshingCredits && "animate-spin")} />
            </Button>
          </>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-5">
          <TriangleAlert />
          <AlertTitle>账号数据加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
        <StatCard label="账号数" value={editionAccounts.length} icon={Users} hint={edition === "domestic" ? "Qoder CN" : "Qoder 国际版"} />
        <StatCard
          label="剩余 Credits"
          value={fmtNum(totalRemaining)}
          icon={Sparkles}
          tone="brand"
          hint={`${editionAccounts.filter((a) => (creditMap[a.id]?.quota?.remaining ?? a.quota?.remaining ?? 0) > 0).length} 个账号有余额`}
        />
        <StatCard
          label="7 天内到期"
          value={expiringSoon}
          icon={CalendarClock}
          tone={expiringSoon > 0 ? "amber" : "neutral"}
          hint={expiringSoon > 0 ? "请及时使用或续期" : "暂无即将到期账号"}
        />
        <StatCard
          label="异常账号"
          value={abnormal}
          icon={TriangleAlert}
          tone={abnormal > 0 ? "rose" : "neutral"}
          hint={abnormal > 0 ? "需重登录或额度查询失败" : "所有账号状态正常"}
        />
      </div>

      {editionAccounts.length === 0 ? (
        <EmptyState
          icon={WalletCards}
          title={`暂无${edition === "domestic" ? "国内版" : "国际版"}账号`}
          description="添加账号后即可在这里查看额度、套餐与到期时间。"
        />
      ) : (
        <Card className="mb-6 overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
            <div>
              <h2 className="text-[13px] font-semibold">账号额度</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">剩余比例按当前额度 / 总额计算。</p>
            </div>
            {refreshingCredits ? (
              <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />刷新中
              </span>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-[11.5px]">
              <thead>
                <tr className="border-b border-border/70 bg-muted/25 text-left text-[10.5px] text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">账号</th>
                  <th className="px-3 py-2.5 font-medium">套餐</th>
                  <th className="px-3 py-2.5 font-medium">剩余 / 总量</th>
                  <th className="px-3 py-2.5 font-medium">剩余比例</th>
                  <th className="px-3 py-2.5 font-medium">到期时间</th>
                  <th className="px-5 py-2.5 text-right font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {editionAccounts.map((a) => {
                  const credit = creditMap[a.id];
                  const remaining = credit?.quota?.remaining ?? a.quota?.remaining ?? null;
                  const total = credit?.quota?.total ?? a.quota?.total ?? null;
                  const unit = credit?.quota?.unit || a.quota?.unit || "credits";
                  const percent = accountRemainingPercent(a, credit);
                  const expireAt = credit?.expiresAt ?? a.quota?.expiresAt ?? null;
                  const planPart = credit?.quota?.plan ?? a.quota?.plan ?? null;
                  const addOnPart = credit?.quota?.addOn ?? a.quota?.addOn ?? null;
                  const quotaData = hasQuotaData(credit?.quota ?? a.quota);
                  const exhausted = Boolean(credit?.isQuotaExceeded ?? a.quota?.isQuotaExceeded) && quotaData && (remaining ?? 0) <= 0;
                  const left = daysLeft(expireAt);
                  const loading = creditLoadingMap[a.id];
                  const error = creditErrorMap[a.id];
                  return (
                    <tr key={a.id} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/[0.08] text-[10.5px] font-semibold text-primary">
                            {(a.name || a.email || a.uid || "?").charAt(0).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <div className="max-w-[220px] truncate font-medium">{a.name || a.email || a.phone || a.uid}</div>
                            <div className="max-w-[220px] truncate text-[10px] text-muted-foreground">{a.email || a.uid || a.userType || "—"}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {a.plan?.planTierName ? (
                          <Badge variant="secondary" className="h-5 text-[10px] font-normal">{a.plan.planTierName}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 tabular-nums">
                        <span className="font-medium">{fmtNum(remaining)}</span>
                        <span className="text-muted-foreground"> / {fmtNum(total)} {unit}</span>
                        {addOnPart ? (
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {planPart ? `基础 ${fmtNum(planPart.remaining)}/${fmtNum(planPart.total)} · ` : ""}
                            赠送 {fmtNum(addOnPart.remaining)}/{fmtNum(addOnPart.total)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        {percent == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  percent <= 10 ? "bg-destructive" : percent <= 30 ? "bg-amber-500" : "bg-primary",
                                )}
                                style={{ width: `${percent > 0 ? Math.max(2, percent) : 0}%` }}
                              />
                            </div>
                            <span className="text-[10.5px] tabular-nums text-muted-foreground">{percent.toFixed(0)}%</span>
                          </div>
                        )}
                      </td>
                      <td className={cn(
                        "px-3 py-3 text-[11px] tabular-nums",
                        left != null && left < 0 ? "text-destructive" : left != null && left <= 7 ? "text-amber-600 dark:text-amber-400" : "",
                      )}>
                        {fmtDate(expireAt)}
                        {left != null ? (
                          <div className="text-[10px] text-muted-foreground">{left < 0 ? "已过期" : `剩 ${left} 天`}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {loading ? (
                          <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />
                        ) : error ? (
                          <Badge variant="destructive" className="h-5 text-[10px]" title={error}>查询失败</Badge>
                        ) : a.status === "needs_relogin" ? (
                          <Badge variant="warning" className="h-5 text-[10px]">需重登录</Badge>
                        ) : a.cooling ? (
                          <Badge variant="secondary" className="h-5 text-[10px]">冷却中</Badge>
                        ) : exhausted ? (
                          <Badge variant="warning" className="h-5 text-[10px]">额度用尽</Badge>
                        ) : (
                          <Badge variant="success" className="h-5 text-[10px]">正常</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
          <div className="flex items-center gap-2">
            <Coins className="size-4 text-muted-foreground" />
            <div>
              <h2 className="text-[13px] font-semibold">最近签到记录</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">每日奖励领取结果，最多显示 50 条。</p>
            </div>
          </div>
          {logsLoading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
        </div>
        {checkinLogs.length === 0 ? (
          <EmptyState
            compact
            icon={Coins}
            title="还没有签到记录"
            description="在账号管理页点击「批量签到」，或开启自动签到后，这里会记录每次领取结果。"
            className="m-5 border-0 bg-transparent"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[11.5px]">
              <thead>
                <tr className="border-b border-border/70 bg-muted/25 text-left text-[10.5px] text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">时间</th>
                  <th className="px-3 py-2.5 font-medium">版本</th>
                  <th className="px-3 py-2.5 font-medium">结果</th>
                  <th className="px-5 py-2.5 text-right font-medium">奖励</th>
                </tr>
              </thead>
              <tbody>
                {checkinLogs.slice(0, 50).map((log, i) => {
                  const result = String(log.result);
                  return (
                    <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
                      <td className="px-5 py-2.5 tabular-nums text-muted-foreground">
                        {new Date(Number(log.ts)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant="secondary" className="h-5 text-[10px] font-normal">
                          {String(log.edition) === "domestic" ? "国内" : "国际"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        {result === "success" ? (
                          <Badge variant="success" className="h-5 text-[10px]">成功</Badge>
                        ) : result === "replayed" ? (
                          <Badge variant="secondary" className="h-5 text-[10px]">已领取</Badge>
                        ) : result === "error" ? (
                          <Badge variant="destructive" className="h-5 text-[10px]" title={String(log.error)}>失败</Badge>
                        ) : (
                          <Badge variant="secondary" className="h-5 text-[10px]">{result}</Badge>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right tabular-nums">
                        {log.rewardCredit != null ? `+${Number(log.rewardCredit).toLocaleString()}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

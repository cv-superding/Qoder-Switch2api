import { useEffect, useMemo, useState } from "react";
import { Coins, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as api from "@/lib/api";
import type { Account, Edition } from "@/lib/types";
import { useAccountsStore } from "@/stores/accounts";

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "长期有效";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysLeft(ts: number | null | undefined): number | null {
  if (!ts) return null;
  return Math.ceil((ts - Date.now()) / 86400000);
}

/** 积分统计：各账号额度、到期、签到状态 */
export default function CreditStatsPage() {
  const { accounts, creditMap, creditLoadingMap, refreshingCredits, fetchAll, refreshCredits, ensureCredits } = useAccountsStore();
  const [edition, setEdition] = useState<Edition>("domestic");
  const [checkinLogs, setCheckinLogs] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    void fetchAll();
    api.api.getCheckinLogs().then((res) => setCheckinLogs(res.logs ?? [])).catch(() => {});
  }, [fetchAll]);

  useEffect(() => {
    if (accounts.length > 0) void ensureCredits(accounts.map((a) => a.id));
  }, [accounts, ensureCredits]);

  const editionAccounts = useMemo(
    () => accounts.filter((a) => (a.edition === "international") === (edition === "international")),
    [accounts, edition],
  );

  async function onRefresh() {
    await refreshCredits(editionAccounts.map((a) => a.id));
    toast.success("积分已刷新");
  }

  const totalRemaining = editionAccounts.reduce((sum, a) => sum + (creditMap[a.id]?.quota?.remaining ?? 0), 0);
  const expiringSoon = editionAccounts.filter((a) => {
    const d = daysLeft(creditMap[a.id]?.expiresAt ?? a.quota?.expiresAt);
    return d != null && d <= 7;
  }).length;

  return (
    <div>
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-tight">积分统计</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            各账号 Credits 额度、到期时间与签到记录。数据来自 Qoder 官方 openapi（/api/v2/quota/usage、/api/v2/user/plan）。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
            {(["domestic", "international"] as Edition[]).map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => setEdition(e)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${edition === e ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              >
                {e === "domestic" ? "国内版" : "国际版"}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" className="size-9 rounded-lg" onClick={() => void onRefresh()} disabled={refreshingCredits}>
            <RefreshCw className={refreshingCredits ? "animate-spin" : undefined} />
          </Button>
        </div>
      </header>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground">账号数</div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums">{editionAccounts.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground">剩余 Credits 合计</div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums">{totalRemaining.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground">7 天内到期</div>
            <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${expiringSoon > 0 ? "text-orange-600" : ""}`}>{expiringSoon}</div>
          </CardContent>
        </Card>
      </div>

      {editionAccounts.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
          暂无{edition === "domestic" ? "国内版" : "国际版"}账号。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">账号</th>
                <th className="px-4 py-2.5 font-medium">套餐</th>
                <th className="px-4 py-2.5 font-medium">剩余 / 总量</th>
                <th className="px-4 py-2.5 font-medium">用量占比</th>
                <th className="px-4 py-2.5 font-medium">到期</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {editionAccounts.map((a) => {
                const q = creditMap[a.id]?.quota;
                const remaining = q?.remaining ?? a.quota?.remaining ?? null;
                const total = q?.total ?? a.quota?.total ?? null;
                const percentage = q?.percentage ?? null;
                const expireAt = creditMap[a.id]?.expiresAt ?? a.quota?.expiresAt ?? null;
                const left = daysLeft(expireAt);
                return (
                  <tr key={a.id} className="border-b border-border/50 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{a.name || a.email || a.phone || a.uid}</div>
                      <div className="text-xs text-muted-foreground">{a.userType || "—"}</div>
                    </td>
                    <td className="px-4 py-3 text-xs">{a.plan?.planTierName || creditMap[a.id] ? "—" : "—"}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {remaining != null ? remaining.toLocaleString() : "—"}
                      <span className="text-muted-foreground"> / {total != null ? total.toLocaleString() : "—"}</span>
                    </td>
                    <td className="px-4 py-3">
                      {percentage != null ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full ${percentage > 90 ? "bg-destructive" : percentage > 70 ? "bg-amber-500" : "bg-primary"}`}
                              style={{ width: `${Math.min(100, percentage)}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground">{percentage.toFixed(0)}%</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-xs tabular-nums ${left != null && left < 0 ? "text-destructive" : left != null && left <= 7 ? "text-orange-600" : ""}`}>
                      {fmtDate(expireAt)}
                      {left != null ? <div className="text-[10px] text-muted-foreground">{left < 0 ? "已过期" : `剩 ${left} 天`}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      {creditLoadingMap[a.id] ? (
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      ) : a.status === "needs_relogin" ? (
                        <Badge variant="destructive" className="h-5 text-[10px]">需重登录</Badge>
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
      )}

      {checkinLogs.length > 0 ? (
        <div className="mt-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Coins className="size-4" />
            最近签到记录
          </h2>
          <div className="max-h-64 overflow-y-auto rounded-xl border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">时间</th>
                  <th className="px-4 py-2 font-medium">版本</th>
                  <th className="px-4 py-2 font-medium">结果</th>
                  <th className="px-4 py-2 font-medium">奖励</th>
                </tr>
              </thead>
              <tbody>
                {checkinLogs.slice(0, 50).map((log, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="px-4 py-1.5 tabular-nums text-muted-foreground">
                      {new Date(Number(log.ts)).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="px-4 py-1.5">{String(log.edition) === "domestic" ? "国内" : "国际"}</td>
                    <td className="px-4 py-1.5">
                      {String(log.result) === "success" ? <span className="text-emerald-600">成功</span> : String(log.result) === "error" ? <span className="text-destructive" title={String(log.error)}>失败</span> : String(log.result)}
                    </td>
                    <td className="px-4 py-1.5 tabular-nums">{log.rewardCredit != null ? `+${log.rewardCredit}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

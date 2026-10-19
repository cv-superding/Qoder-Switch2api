import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import * as api from "@/lib/api";
import type { UsageStats } from "@/lib/types";

const SERIES = ["var(--data-series-emerald)", "var(--data-series-teal)", "var(--data-series-indigo)", "var(--data-series-violet)", "var(--data-series-amber)", "var(--data-series-rose)", "var(--data-series-sky)", "var(--data-series-lime)"];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Token 统计：趋势图 + 按账号 / 模型 / API 分布 */
export default function TokenStatsPage() {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [edition, setEdition] = useState<string>("");

  async function load() {
    setLoading(true);
    try {
      setUsage(await api.api.getUsage(edition || undefined));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition]);

  const daily = usage?.daily ?? [];
  const byModel = usage?.byModel ?? [];
  const byApi = usage?.byApi ?? [];

  return (
    <div>
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-tight">Token 统计</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            反代请求数、输入 / 输出 Token 消耗趋势，按账号、模型与 API 类型分布。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
            {[{ v: "", l: "全部" }, { v: "domestic", l: "国内版" }, { v: "international", l: "国际版" }].map((e) => (
              <button
                key={e.v}
                type="button"
                onClick={() => setEdition(e.v)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${edition === e.v ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              >
                {e.l}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" className="size-9 rounded-lg" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>
      </header>

      {loading && !usage ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="animate-spin" />
          加载中…
        </div>
      ) : !usage || usage.totals.requests === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
          暂无反代用量记录。在「API 反代」页启用网关并发出请求后，这里会出现趋势与分布。
        </div>
      ) : (
        <div className="space-y-6">
          {/* 总览 */}
          <div className="grid gap-4 sm:grid-cols-4" aria-label="Token 总览">
            {[
              { label: "总请求", value: usage.totals.requests.toLocaleString() },
              { label: "输入 Token", value: usage.totals.promptTokens.toLocaleString() },
              { label: "输出 Token", value: usage.totals.completionTokens.toLocaleString() },
              { label: "失败请求", value: usage.totals.errors.toLocaleString() },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="pt-5">
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                  <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{s.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* 趋势 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">每日趋势（最近 30 天）</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={daily} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--data-series-indigo)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--data-series-indigo)" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--data-series-emerald)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--data-series-emerald)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" tickFormatter={fmt} width={44} />
                    <RTooltip
                      contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--popover-foreground)" }}
                      labelStyle={{ color: "var(--muted-foreground)" }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="promptTokens" name="输入" stroke="var(--data-series-indigo)" fill="url(#gIn)" strokeWidth={2} />
                    <Area type="monotone" dataKey="completionTokens" name="输出" stroke="var(--data-series-emerald)" fill="url(#gOut)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* 按模型 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">按模型分布</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={byModel} layout="vertical" margin={{ left: 0, right: 16, top: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" tickFormatter={fmt} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" width={80} />
                      <RTooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--popover-foreground)" }} />
                      <Bar dataKey="totalTokens" name="总 Token" radius={[0, 4, 4, 0]}>
                        {byModel.map((_, i) => (
                          <Cell key={i} fill={SERIES[i % SERIES.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* 按账号 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">按账号分布</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={usage.byAccount ?? []}
                        dataKey="totalTokens"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        innerRadius={44}
                        outerRadius={72}
                        paddingAngle={2}
                        strokeWidth={1}
                      >
                        {(usage.byAccount ?? []).map((_, i) => (
                          <Cell key={i} fill={SERIES[i % SERIES.length]} />
                        ))}
                      </Pie>
                      <RTooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--popover-foreground)" }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* 按 API */}
          {byApi.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">按 API 类型</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-3">
                  {byApi.map((row) => (
                    <div key={row.name} className="rounded-lg border bg-muted/30 px-4 py-3">
                      <div className="text-xs text-muted-foreground">
                        {row.name === "chat" ? "Chat Completions" : row.name === "responses" ? "Responses（Codex）" : row.name === "messages" ? "Messages（Claude Code）" : row.name}
                      </div>
                      <div className="mt-1 text-sm font-semibold tabular-nums">{row.requests} 次 · {fmt(row.totalTokens)} tokens</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* 最近记录 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">最近请求</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">时间</th>
                      <th className="py-2 pr-4 font-medium">版本</th>
                      <th className="py-2 pr-4 font-medium">账号</th>
                      <th className="py-2 pr-4 font-medium">模型</th>
                      <th className="py-2 pr-4 font-medium">Tokens</th>
                      <th className="py-2 font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(usage.recent ?? []).map((r, i) => (
                      <tr key={i} className="border-b border-border/50">
                        <td className="py-1.5 pr-4 tabular-nums text-muted-foreground">
                          {new Date(r.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td className="py-1.5 pr-4">{r.edition === "domestic" ? "国内" : "国际"}</td>
                        <td className="py-1.5 pr-4 max-w-[140px] truncate">{r.accountName || "—"}</td>
                        <td className="py-1.5 pr-4 font-mono">{r.model}</td>
                        <td className="py-1.5 pr-4 tabular-nums">{r.totalTokens.toLocaleString()}</td>
                        <td className="py-1.5">
                          {r.success ? <span className="text-emerald-600">成功</span> : <span className="text-destructive" title={r.error}>失败</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

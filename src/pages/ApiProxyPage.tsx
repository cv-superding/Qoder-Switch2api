import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity, Check, Copy, Eye, EyeOff, Gauge, Globe2, Info, KeyRound, ListPlus, Loader2, Network, RefreshCw, Save,
  ServerCog, Trash2, TriangleAlert, Users,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import * as api from "@/lib/api";
import { accountGroupLabel, type Edition, type ProxyConfig, type ProxyStatus, type UsageStats } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 反代配置页：每个版本一套独立配置 */
export default function ApiProxyPage({ edition }: { edition: Edition }) {
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus | null>(null);
  const [proxyAccounts, setProxyAccounts] = useState(0);
  const [otherProxyAccounts, setOtherProxyAccounts] = useState(0);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [extraModel, setExtraModel] = useState("");
  const [models, setModels] = useState<{ id: string; displayName: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [copied, setCopied] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  const isDomestic = edition === "domestic";
  const label = isDomestic ? "国内版" : "国际版";
  const productLabel = isDomestic ? "Qoder CN（国内版）" : "Qoder（国际版）";
  const otherEdition: Edition = isDomestic ? "international" : "domestic";
  const otherLabel = isDomestic ? "国际版" : "国内版";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    setConfig(null);
    setDirty(false);
    setModels([]);
    setExtraModel("");
    async function loadAll() {
      try {
        const [cfgRes, statusRes] = await Promise.all([api.api.getProxyConfig(), api.api.getStatus()]);
        if (cancelled) return;
        const editionStatus = statusRes.editions[edition];
        setConfig(cfgRes.proxy[edition]);
        setProxyStatus(editionStatus.proxy);
        setProxyAccounts(editionStatus.proxyAccounts);
        setOtherProxyAccounts(statusRes.editions[otherEdition].proxyAccounts);
        const usageRes = await api.api.getUsage(edition).catch(() => null);
        if (!cancelled && usageRes) setUsage(usageRes);
      } catch (e) {
        if (!cancelled) {
          setLoadError(api.asError(e));
          toast.error("加载反代配置失败", { description: api.asError(e) });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadAll();
    return () => {
      cancelled = true;
    };
  }, [edition, reloadKey]);

  async function refreshStatus() {
    const statusRes = await api.api.getStatus();
    setProxyStatus(statusRes.editions[edition].proxy);
    setProxyAccounts(statusRes.editions[edition].proxyAccounts);
    setOtherProxyAccounts(statusRes.editions[otherEdition].proxyAccounts);
  }

  async function save(next: ProxyConfig, message = "配置已保存") {
    setSaving(true);
    try {
      const res = await api.api.saveProxyConfig({ [edition]: next });
      setConfig(res.proxy[edition]);
      setDirty(false);
      await refreshStatus();
      toast.success(message);
    } catch (e) {
      toast.error("保存失败", { description: api.asError(e) });
    } finally {
      setSaving(false);
    }
  }

  function edit(patch: Partial<ProxyConfig>) {
    if (!config) return;
    setConfig({ ...config, ...patch });
    setDirty(true);
  }

  async function fetchModels() {
    setModelsLoading(true);
    try {
      const res = await api.api.fetchProxyModels(edition);
      setModels(res.models);
      if (res.models.length === 0) toast.info("上游未返回模型列表", { description: "仍可使用 auto / lite 或手动添加模型 ID" });
    } catch (e) {
      toast.error("获取模型列表失败", { description: api.asError(e) });
    } finally {
      setModelsLoading(false);
    }
  }

  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      toast.error("复制失败");
    }
  }

  const listenHost = config?.listen || (isDomestic ? "127.0.0.1:7891" : "127.0.0.1:7892");
  const baseUrl = `http://${listenHost}/v1`;
  const running = Boolean(proxyStatus?.running);
  const enabled = Boolean(config?.enabled);

  const endpointRows = useMemo(
    () => [
      { key: "base", name: "Base URL", hint: "OpenAI SDK / Cherry Studio / NextChat", value: baseUrl },
      { key: "chat", name: "Chat Completions", hint: "OpenAI 对话接口", value: `${baseUrl}/chat/completions` },
      { key: "responses", name: "Responses", hint: "Codex CLI", value: `${baseUrl}/responses` },
      { key: "messages", name: "Messages", hint: "Claude Code（ANTHROPIC_BASE_URL）", value: baseUrl },
      { key: "models", name: "模型列表", hint: "OpenAI /v1/models", value: `${baseUrl}/models` },
      { key: "health", name: "健康检查", hint: "运行状态", value: `http://${listenHost}/healthz` },
    ],
    [baseUrl, listenHost],
  );

  return (
    <div>
      <PageHeader
        icon={isDomestic ? Network : Globe2}
        title={`${productLabel} API 反代`}
        description={`把${label}账号池包装成 OpenAI / Anthropic 兼容的本地网关。请求按账号池轮转，失败自动冷却并换号。`}
        actions={
          <>
            <Badge
              variant="secondary"
              className={cn(
                "h-8 gap-1.5 border px-3 text-[11px]",
                running
                  ? "border-primary/20 bg-primary/[0.07] text-primary"
                  : enabled
                    ? "border-amber-500/25 bg-amber-500/[0.07] text-amber-700 dark:text-amber-400"
                    : "border-border bg-muted/40 text-muted-foreground",
              )}
            >
              <span className={cn("size-1.5 rounded-full", running ? "bg-primary" : enabled ? "bg-amber-500" : "bg-muted-foreground/40")} />
              {running ? "监听中" : enabled ? "未启动" : "未启用"}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              onClick={() => {
                void refreshStatus();
                void api.api.getUsage(edition).then(setUsage).catch(() => {});
              }}
              aria-label="刷新状态"
            >
              <RefreshCw className="size-4" />
            </Button>
          </>
        }
      />

      {!loading && proxyAccounts === 0 ? (
        <Alert className="mb-5">
          <Info />
          <AlertTitle>当前{label}没有可用账号</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {otherProxyAccounts > 0
                ? `检测到${otherLabel}已有 ${otherProxyAccounts} 个可用账号。两个版本的账号池完全独立，反代不会自动混用。`
                : "请先在「账号管理」添加账号，并确认账号分组不是「桌面端」。"}
            </span>
            <Button asChild size="sm" variant="outline">
              <Link to={otherProxyAccounts > 0 ? `/api-proxy/${otherEdition}` : "/"}>
                {otherProxyAccounts > 0 ? `前往${otherLabel}反代` : "前往账号管理"}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-[94px] animate-pulse rounded-2xl border border-border/70 bg-card/60" />)}
          </div>
          <div className="h-52 animate-pulse rounded-2xl border border-border/70 bg-card/60" />
          <div className="h-72 animate-pulse rounded-2xl border border-border/70 bg-card/60" />
        </div>
      ) : !config ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>无法加载反代配置</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{loadError || "请确认本地服务正在运行"}</span>
            <Button size="sm" variant="outline" onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCw />重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
            <StatCard
              label="运行状态"
              value={running ? "监听中" : enabled ? "未启动" : "未启用"}
              icon={Activity}
              tone={running ? "brand" : enabled ? "amber" : "neutral"}
              hint={running ? `端口 ${listenHost.split(":").pop()}` : enabled ? "请检查端口占用" : "打开下方开关启用"}
            />
            <StatCard
              label="可用账号"
              value={proxyAccounts}
              icon={Users}
              tone={proxyAccounts > 0 ? "sky" : "neutral"}
              hint={proxyAccounts > 0 ? "参与反代的账号池" : "当前版本暂无可用账号"}
            />
            <StatCard label="累计请求" value={(usage?.totals.requests ?? 0).toLocaleString()} icon={Gauge} hint="本版本累计" />
            <StatCard
              label="失败请求"
              value={(usage?.totals.errors ?? 0).toLocaleString()}
              icon={TriangleAlert}
              tone={(usage?.totals.errors ?? 0) > 0 ? "rose" : "neutral"}
              hint="上游错误 / 鉴权失败"
            />
          </div>

          {proxyStatus?.error ? (
            <Alert variant="destructive" className="mb-5">
              <TriangleAlert />
              <AlertTitle>反代监听失败</AlertTitle>
              <AlertDescription>{proxyStatus.error}。请修改监听端口或关闭占用该端口的程序后重新保存。</AlertDescription>
            </Alert>
          ) : null}

          {/* 状态与接入地址 */}
          <Card className="mb-5 overflow-hidden">
            <div className="grid lg:grid-cols-[1.15fr_1fr]">
              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/[0.07] text-primary">
                      <ServerCog className="size-[18px]" strokeWidth={1.8} />
                    </span>
                    <div>
                      <div className="text-[13px] font-semibold">启用{label}接口</div>
                      <p className="mt-1 max-w-md text-[11.5px] leading-5 text-muted-foreground">
                        {isDomestic
                          ? "使用 Qoder CN 账号池，对接 openapi.qoder.com.cn / gateway.qoder.com.cn。"
                          : "使用 Qoder 国际版账号池，对接 openapi.qoder.sh / api3.qoder.sh。"}
                      </p>
                    </div>
                  </div>
                  <Switch
                    id={`proxy-enabled-${edition}`}
                    checked={enabled}
                    onCheckedChange={(v) => void save({ ...config, enabled: v }, v ? `已启用${label}反代` : `已停止${label}反代`)}
                    aria-label={`启用${label}反代`}
                  />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className={cn("size-1.5 rounded-full", running ? "bg-primary" : "bg-muted-foreground/40")} />
                    {listenHost}
                  </span>
                  <Badge variant="outline" className="h-7 text-[10.5px] font-normal">
                    取号：{accountGroupLabel("proxy")} + 未分组
                  </Badge>
                  <Badge variant="outline" className="h-7 text-[10.5px] font-normal">
                    {config.apiKey ? "已设置 API Key" : "任意 Key 可用"}
                  </Badge>
                </div>
              </div>

              <div className="border-t border-border/70 bg-muted/20 p-5 lg:border-l lg:border-t-0">
                <div className="text-[10.5px] font-medium tracking-[0.04em] text-muted-foreground">Base URL</div>
                <div className="mt-2 flex items-center gap-2 rounded-xl border border-border/80 bg-card px-3 py-2.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{baseUrl}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 rounded-md"
                    onClick={() => void copyText(baseUrl, "base-url")}
                    aria-label="复制 Base URL"
                  >
                    {copied === "base-url" ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
                  </Button>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[10.5px] text-muted-foreground">
                  <div className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-2">
                    <div className="text-muted-foreground/70">Codex CLI</div>
                    <div className="mt-0.5 truncate font-mono text-foreground/80">/v1/responses</div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-card/60 px-2.5 py-2">
                    <div className="text-muted-foreground/70">Claude Code</div>
                    <div className="mt-0.5 truncate font-mono text-foreground/80">/v1/messages</div>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* 连接配置 */}
          <Card className="mb-5">
            <CardContent className="p-0">
              <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
                <div>
                  <h3 className="text-[13px] font-semibold">连接配置</h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">修改监听地址或 API Key 后点击保存生效。</p>
                </div>
                <div className="flex items-center gap-2">
                  {dirty ? <Badge variant="warning" className="h-6 text-[10px]">未保存</Badge> : null}
                  <Button size="sm" className="h-8" disabled={!dirty || saving} onClick={() => void save(config)}>
                    {saving ? <Loader2 className="animate-spin" /> : <Save />}
                    保存
                  </Button>
                </div>
              </div>

              <div className="divide-y divide-border/60">
                <SettingRow
                  icon={<Network className="size-4" />}
                  label="监听地址"
                  hint="建议保持 127.0.0.1；仅受信任的内网才改为 0.0.0.0。"
                  htmlFor={`proxy-listen-${edition}`}
                >
                  <Input
                    id={`proxy-listen-${edition}`}
                    value={config.listen}
                    onChange={(e) => edit({ listen: e.target.value })}
                    className="h-9 w-full font-mono text-xs sm:w-52"
                    placeholder={isDomestic ? "127.0.0.1:7891" : "127.0.0.1:7892"}
                  />
                </SettingRow>

                <SettingRow
                  icon={<KeyRound className="size-4" />}
                  label="API Key（可选）"
                  hint="设置后客户端需携带 Bearer Key；留空则任意 Key 可用。"
                  htmlFor={`proxy-key-${edition}`}
                >
                  <div className="relative w-full sm:w-52">
                    <Input
                      id={`proxy-key-${edition}`}
                      type={showApiKey ? "text" : "password"}
                      value={config.apiKey}
                      onChange={(e) => edit({ apiKey: e.target.value })}
                      className="h-9 w-full pr-9 font-mono text-xs"
                      placeholder="sk-..."
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => setShowApiKey((v) => !v)}
                      aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                    >
                      {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                </SettingRow>

                <SettingRow
                  icon={<Users className="size-4" />}
                  label="取号范围"
                  hint={`仅「${accountGroupLabel("proxy")} / 未分组」账号参与反代，桌面端专用号不参与。`}
                >
                  <Badge variant="secondary" className="h-7 text-[10.5px] font-normal">
                    {accountGroupLabel("proxy")} + 未分组
                  </Badge>
                </SettingRow>
              </div>
            </CardContent>
          </Card>

          {/* 接入地址 */}
          <Card className="mb-5">
            <CardContent className="p-0">
              <div className="border-b border-border/70 px-5 py-4">
                <h3 className="text-[13px] font-semibold">客户端接入</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">复制对应地址到客户端，API Key 与上方配置保持一致。</p>
              </div>
              <div className="grid gap-2 p-4 md:grid-cols-2">
                {endpointRows.map((row) => (
                  <div
                    key={row.key}
                    className="group flex items-center justify-between gap-3 rounded-xl border border-border/75 bg-muted/15 px-3 py-2.5 transition-colors hover:bg-muted/35"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
                        {row.name}
                        <span className="font-normal text-muted-foreground/70">{row.hint}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">{row.value}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 rounded-md text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100"
                      onClick={() => void copyText(row.value, row.key)}
                      aria-label={`复制 ${row.name}`}
                    >
                      {copied === row.key ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* 额外放行模型 */}
          <Card className="mb-5">
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
                <div>
                  <h3 className="text-[13px] font-semibold">额外放行模型</h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">加入 /v1/models 并跳过模型校验。</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={fetchModels}
                  disabled={modelsLoading || proxyAccounts === 0}
                  title={proxyAccounts === 0 ? "当前版本没有可用账号，无法获取上游模型" : undefined}
                >
                  {modelsLoading ? <Loader2 className="animate-spin" /> : <ListPlus />}
                  获取上游模型
                </Button>
              </div>
              <div className="space-y-3 px-5 py-4">
                <div className="flex flex-wrap gap-1.5">
                  {(config.extraModels || []).map((m) => (
                    <Badge key={m} variant="secondary" className="h-7 gap-1 px-2 font-mono text-[10.5px]">
                      {m}
                      <button
                        type="button"
                        aria-label={`删除 ${m}`}
                        onClick={() => edit({ extraModels: (config.extraModels || []).filter((x) => x !== m) })}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </Badge>
                  ))}
                  {(config.extraModels || []).length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">暂无自定义模型</span>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={extraModel}
                    onChange={(e) => setExtraModel(e.target.value)}
                    placeholder="模型 ID，例如 qwen3-coder-plus"
                    className="h-9 max-w-sm font-mono text-xs"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && extraModel.trim()) {
                        edit({ extraModels: [...(config.extraModels || []), extraModel.trim()] });
                        setExtraModel("");
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9"
                    disabled={!extraModel.trim()}
                    onClick={() => {
                      edit({ extraModels: [...(config.extraModels || []), extraModel.trim()] });
                      setExtraModel("");
                    }}
                  >
                    添加
                  </Button>
                </div>
                {models.length > 0 ? (
                  <div>
                    <div className="mb-1.5 text-[10.5px] text-muted-foreground">上游返回的模型，点击加入：</div>
                    <div className="flex flex-wrap gap-1.5">
                      {models.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="rounded-lg border border-border/80 bg-card px-2 py-1 font-mono text-[10.5px] transition-colors hover:border-primary/30 hover:bg-primary/[0.04]"
                          onClick={() => {
                            if (!(config.extraModels || []).includes(m.id)) {
                              edit({ extraModels: [...(config.extraModels || []), m.id] });
                            }
                          }}
                        >
                          {m.displayName || m.id}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-border/75 bg-muted/25 px-4 py-3 text-[11.5px] leading-5 text-muted-foreground">
            <RefreshCw className="mt-0.5 size-3.5 shrink-0" />
            <p>
              轮转策略：健康账号优先（额度剩余多的排前），同级 round-robin；请求失败自动冷却 120 秒，
              401 / 403 会尝试一次 Token 续期后换号。可在账号卡片菜单中把账号加入「{accountGroupLabel("proxy")}」分组。
            </p>
          </div>

          {/* 本版本用量 */}
          <Card>
            <CardContent className="p-0">
              <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
                <div>
                  <h3 className="text-[13px] font-semibold">本版本用量</h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">按账号聚合的请求与 Token 消耗。</p>
                </div>
                <Badge variant="outline" className="h-6 text-[10.5px] font-normal">
                  {usage?.totals.requests ?? 0} 次请求
                </Badge>
              </div>
              {usage && usage.totals.requests > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-[11.5px]">
                    <thead>
                      <tr className="border-b border-border/70 bg-muted/25 text-left text-[10.5px] text-muted-foreground">
                        <th className="px-5 py-2.5 font-medium">账号</th>
                        <th className="px-3 py-2.5 font-medium">请求</th>
                        <th className="px-3 py-2.5 font-medium">输入 Token</th>
                        <th className="px-3 py-2.5 font-medium">输出 Token</th>
                        <th className="px-3 py-2.5 font-medium">失败</th>
                        <th className="px-5 py-2.5 text-right font-medium">成功率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(usage.byAccount ?? []).map((row) => {
                        const rate = row.requests > 0 ? ((row.requests - row.errors) / row.requests) * 100 : 0;
                        return (
                          <tr key={row.name} className="border-b border-border/50 last:border-0">
                            <td className="max-w-[220px] truncate px-5 py-2.5 font-medium">{row.name}</td>
                            <td className="px-3 py-2.5 tabular-nums">{row.requests.toLocaleString()}</td>
                            <td className="px-3 py-2.5 tabular-nums">{row.promptTokens.toLocaleString()}</td>
                            <td className="px-3 py-2.5 tabular-nums">{row.completionTokens.toLocaleString()}</td>
                            <td className={cn("px-3 py-2.5 tabular-nums", row.errors > 0 && "text-destructive")}>{row.errors}</td>
                            <td className="px-5 py-2.5 text-right tabular-nums text-muted-foreground">{rate.toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  compact
                  icon={ServerCog}
                  title="暂无用量记录"
                  description="启用反代并发出第一笔请求后，这里会显示按账号的统计。"
                  className="m-5 border-0 bg-transparent"
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function SettingRow({
  icon, label, hint, htmlFor, children,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div>
          <Label htmlFor={htmlFor} className="text-[12.5px]">{label}</Label>
          <p className="mt-0.5 max-w-md text-[10.5px] leading-5 text-muted-foreground">{hint}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

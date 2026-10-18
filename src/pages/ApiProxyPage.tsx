import { useEffect, useState } from "react";
import { Check, Copy, ListPlus, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import * as api from "@/lib/api";
import { accountGroupLabel, type Account, type Edition, type ProxyConfig, type UsageStats } from "@/lib/types";

/** 反代配置页：每个版本一套独立配置 */
export default function ApiProxyPage({ edition }: { edition: Edition }) {
  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [status, setStatus] = useState<{ running: boolean; accounts: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [extraModel, setExtraModel] = useState("");
  const [models, setModels] = useState<{ id: string; displayName: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [copied, setCopied] = useState("");

  const isDomestic = edition === "domestic";
  const label = isDomestic ? "国内版" : "国际版";

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition]);

  async function loadAll() {
    try {
      const [cfgRes, statusRes] = await Promise.all([api.api.getProxyConfig(), api.api.getStatus()]);
      setConfig(cfgRes.proxy[edition]);
      const es = statusRes.editions[edition];
      setStatus({ running: es.proxy.running, accounts: es.proxyAccounts });
      setUsage(await api.api.getUsage(edition));
    } catch (e) {
      toast.error("加载反代配置失败", { description: api.asError(e) });
    }
  }

  async function save(next: ProxyConfig) {
    setSaving(true);
    try {
      await api.api.saveProxyConfig({ [edition]: next });
      setConfig(next);
      const statusRes = await api.api.getStatus();
      setStatus({ running: statusRes.editions[edition].proxy.running, accounts: statusRes.editions[edition].proxyAccounts });
      toast.success(`${label}反代配置已保存`);
    } catch (e) {
      toast.error("保存失败", { description: api.asError(e) });
    } finally {
      setSaving(false);
    }
  }

  async function fetchModels() {
    setModelsLoading(true);
    try {
      const res = await api.api.fetchProxyModels(edition);
      setModels(res.models);
      if (res.models.length === 0) toast.info("上游未返回额外模型，使用默认列表（auto / lite）");
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

  if (!config) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="animate-spin" />
        加载中…
      </div>
    );
  }

  const listenHost = config.listen;
  const baseUrl = `http://${listenHost}/v1`;

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-[28px] font-semibold tracking-tight">{label} API 反代</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          把{label}账号池包装成 OpenAI / Anthropic 兼容的本地网关，任何 SDK 客户端都能直接使用。
          请求按账号池自动轮转，失败自动冷却。
        </p>
      </header>

      {/* 状态卡 */}
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground">运行状态</div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className={`inline-block size-2 rounded-full ${status?.running ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
              <span className="text-sm font-medium">{status?.running ? "监听中" : "未启用"}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground">可用账号（反代池）</div>
            <div className="mt-1.5 text-sm font-medium tabular-nums">{status?.accounts ?? 0} 个</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground">累计请求</div>
            <div className="mt-1.5 text-sm font-medium tabular-nums">{usage?.totals.requests ?? 0} 次</div>
          </CardContent>
        </Card>
      </div>

      {/* 配置区 */}
      <Card className="mb-6">
        <CardContent className="px-4 py-1 sm:px-5">
          <div className="flex items-center justify-between gap-3 border-b border-border/50 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Label htmlFor={`proxy-enabled-${edition}`} className="text-[13px] leading-4">启用{label}接口</Label>
                {status?.running ? (
                  <Badge variant="secondary" className="h-5 shrink-0 border-0 px-1.5 text-[10px] leading-5 text-emerald-600">监听中</Badge>
                ) : null}
              </div>
              <p className="mt-0.5 text-xs leading-4 text-muted-foreground/75">
                {isDomestic ? "使用 Qoder CN 账号 · openapi.qoder.com.cn / gateway.qoder.com.cn" : "使用 Qoder 国际版账号 · openapi.qoder.sh / api3.qoder.sh"}
              </p>
            </div>
            <Switch
              id={`proxy-enabled-${edition}`}
              checked={config.enabled}
              onCheckedChange={(v) => void save({ ...config, enabled: v })}
              aria-label={`启用${label}反代`}
            />
          </div>

          <div className="flex flex-col items-stretch justify-between gap-2 border-b border-border/50 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <Label htmlFor={`proxy-listen-${edition}`} className="text-[13px] leading-4">监听地址</Label>
              <p className="mt-0.5 text-xs leading-4 text-muted-foreground/75">建议保持 127.0.0.1；只有受信任的内网才改成 0.0.0.0</p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                id={`proxy-listen-${edition}`}
                value={config.listen}
                onChange={(e) => setConfig({ ...config, listen: e.target.value })}
                className="h-9 w-44 font-mono text-xs"
                placeholder={isDomestic ? "127.0.0.1:7891" : "127.0.0.1:7892"}
              />
              <Button size="sm" variant="outline" className="h-9" disabled={saving} onClick={() => void save(config)}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />}保存
              </Button>
            </div>
          </div>

          <div className="flex flex-col items-stretch justify-between gap-2 border-b border-border/50 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <Label htmlFor={`proxy-key-${edition}`} className="text-[13px] leading-4">API Key（可选）</Label>
              <p className="mt-0.5 text-xs leading-4 text-muted-foreground/75">设置后客户端需带 Authorization: Bearer &lt;key&gt;；留空则任意 Key 可用</p>
            </div>
            <div className="flex items-center gap-2">
              <Input
                id={`proxy-key-${edition}`}
                value={config.apiKey}
                onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                className="h-9 w-44 font-mono text-xs"
                placeholder="sk-..."
              />
              <Button size="sm" variant="outline" className="h-9" disabled={saving} onClick={() => void save(config)}>
                {saving ? <Loader2 className="animate-spin" /> : <Save />}保存
              </Button>
            </div>
          </div>

          <div className="flex flex-col items-stretch justify-between gap-2 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <Label className="text-[13px] leading-4">取号范围</Label>
              <p className="mt-0.5 text-xs leading-4 text-muted-foreground/75">
                仅「{accountGroupLabel("proxy")} / 未分组」账号参与反代（桌面端专用号不参与）
              </p>
            </div>
            <Badge variant="outline" className="w-fit text-xs font-normal">{accountGroupLabel("proxy")} + 未分组</Badge>
          </div>
        </CardContent>
      </Card>

      {/* 接入地址 */}
      <Card className="mb-6">
        <CardContent className="pt-5">
          <h3 className="mb-3 text-sm font-semibold">客户端接入</h3>
          <div className="space-y-2 text-xs">
            {[
              { key: "base", name: "Base URL（OpenAI SDK / Cherry Studio / NextChat）", value: baseUrl },
              { key: "chat", name: "Chat Completions", value: `${baseUrl}/chat/completions` },
              { key: "responses", name: "Responses（Codex CLI）", value: `${baseUrl}/responses` },
              { key: "messages", name: "Messages（Claude Code CLI，ANTHROPIC_BASE_URL）", value: baseUrl },
              { key: "models", name: "模型列表", value: `${baseUrl}/models` },
              { key: "health", name: "健康检查", value: `http://${listenHost}/healthz` },
            ].map((row) => (
              <div key={row.key} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[11px] text-muted-foreground">{row.name}</div>
                  <div className="truncate font-mono text-xs">{row.value}</div>
                </div>
                <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => void copyText(row.value, row.key)}>
                  {copied === row.key ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            推荐模型：<code className="rounded bg-muted px-1">auto</code>（默认）/{" "}
            <code className="rounded bg-muted px-1">lite</code>。也支持直接把 Qoder 模型 key 传给 model 字段。
          </p>
        </CardContent>
      </Card>

      {/* 额外放行模型 */}
      <Card className="mb-6">
        <CardContent className="pt-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">额外放行模型</h3>
            <Button size="sm" variant="outline" className="h-8" onClick={fetchModels} disabled={modelsLoading}>
              {modelsLoading ? <Loader2 className="animate-spin" /> : <ListPlus />}
              获取上游模型 ID
            </Button>
          </div>
          <p className="mb-3 text-xs leading-5 text-muted-foreground">
            上游模型列表不完整时，可手动填写模型 ID 加入 /v1/models 并跳过校验。
          </p>
          <div className="flex flex-wrap gap-2">
            {(config.extraModels || []).map((m) => (
              <Badge key={m} variant="secondary" className="h-7 gap-1 px-2 font-mono text-xs">
                {m}
                <button
                  type="button"
                  aria-label={`删除 ${m}`}
                  onClick={() => void save({ ...config, extraModels: config.extraModels.filter((x) => x !== m) })}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                </button>
              </Badge>
            ))}
            {(!config.extraModels || config.extraModels.length === 0) ? (
              <span className="text-xs text-muted-foreground">暂无</span>
            ) : null}
          </div>
          <div className="mt-3 flex gap-2">
            <Input
              value={extraModel}
              onChange={(e) => setExtraModel(e.target.value)}
              placeholder="模型 ID，例如 qwen3-coder-plus"
              className="h-9 max-w-xs font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter" && extraModel.trim()) {
                  void save({ ...config, extraModels: [...(config.extraModels || []), extraModel.trim()] });
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
                void save({ ...config, extraModels: [...(config.extraModels || []), extraModel.trim()] });
                setExtraModel("");
              }}
            >
              添加
            </Button>
          </div>
          {models.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1.5 text-xs text-muted-foreground">上游返回的模型（点击加入放行列表）：</div>
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="rounded-md border bg-background px-2 py-1 font-mono text-[11px] hover:bg-accent"
                    onClick={() => {
                      if (!(config.extraModels || []).includes(m.id)) {
                        void save({ ...config, extraModels: [...(config.extraModels || []), m.id] });
                      }
                    }}
                  >
                    {m.displayName || m.id}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 账号池提示 */}
      <Alert className="mb-6">
        <AlertDescription>
          轮转策略：健康账号优先（额度剩余多的排前），同级 round-robin；请求失败自动冷却 120 秒，
          401/403 会尝试一次 token 续期后换号。在「账号管理」页把账号分组设为「{accountGroupLabel("proxy")}」
          可让桌面端专用号不参与反代。
        </AlertDescription>
      </Alert>

      <Separator className="my-6" />

      {/* 本版本用量 */}
      <div>
        <h3 className="mb-3 text-sm font-semibold">本版本用量</h3>
        {usage && usage.totals.requests > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">账号</th>
                  <th className="py-2 pr-4 font-medium">请求</th>
                  <th className="py-2 pr-4 font-medium">输入 Token</th>
                  <th className="py-2 pr-4 font-medium">输出 Token</th>
                  <th className="py-2 font-medium">失败</th>
                </tr>
              </thead>
              <tbody>
                {usage.byAccount.map((row) => (
                  <tr key={row.name} className="border-b border-border/50">
                    <td className="py-2 pr-4">{row.name}</td>
                    <td className="py-2 pr-4 tabular-nums">{row.requests}</td>
                    <td className="py-2 pr-4 tabular-nums">{row.promptTokens.toLocaleString()}</td>
                    <td className="py-2 pr-4 tabular-nums">{row.completionTokens.toLocaleString()}</td>
                    <td className="py-2 tabular-nums">{row.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            暂无用量记录。启用反代并发出第一笔请求后，这里会显示按账号的统计。
          </div>
        )}
      </div>
    </div>
  );
}

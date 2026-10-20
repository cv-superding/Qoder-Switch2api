import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarCheck, Check, ChevronDown, ExternalLink, FolderGit2, Github, Info, Loader2, Monitor, Moon, Palette,
  RefreshCw, Save, ShieldCheck, SlidersHorizontal, Sun, TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import * as api from "@/lib/api";
import { applyTheme, getSavedTheme, useTheme, type ThemeMode } from "@/lib/theme";
import type { ClientInfo, Edition, Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", hint: "明亮的工作区", icon: Sun },
  { value: "dark", label: "深色", hint: "低光环境", icon: Moon },
  { value: "system", label: "跟随系统", hint: "自动切换", icon: Monitor },
];

const ENDPOINT_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "openApiBaseUrl", label: "OpenAPI 地址", hint: "账号 / 额度 / 签到接口" },
  { key: "streamUrl", label: "流式对话地址", hint: "Cosy 签名 SSE 接口" },
  { key: "modelListUrl", label: "模型列表地址", hint: "可选" },
  { key: "cloudBaseUrl", label: "Cloud API 地址", hint: "PAT 模式" },
  { key: "clientId", label: "OAuth Client ID", hint: "设备流登录" },
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [initial, setInitial] = useState("");
  const [saving, setSaving] = useState(false);
  const [about, setAbout] = useState<{ name: string; version: string; description: string; references: string[] } | null>(null);
  const [clients, setClients] = useState<Record<Edition, ClientInfo | null>>({ domestic: null, international: null });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [theme, setLocalTheme] = useTheme();

  useEffect(() => {
    setLoadError("");
    Promise.all([api.api.getSettings(), api.api.getAbout().catch(() => null)])
      .then(([s, a]) => {
        setSettings(s.settings);
        setInitial(JSON.stringify(s.settings));
        if (a) setAbout(a);
        if (!getSavedTheme()) applyTheme(s.settings.theme, { persist: false });
      })
      .catch((e) => {
        setLoadError(api.asError(e));
        toast.error("加载设置失败", { description: api.asError(e) });
      });
    for (const edition of ["domestic", "international"] as Edition[]) {
      api.api
        .detectClient(edition)
        .then((res) => setClients((prev) => ({ ...prev, [edition]: res.client })))
        .catch(() => {});
    }
  }, [reloadKey]);

  const dirty = useMemo(
    () => (settings ? JSON.stringify({ ...settings, theme }) !== initial : false),
    [settings, theme, initial],
  );

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await api.api.saveSettings({ ...settings, theme });
      setSettings(res.settings);
      setInitial(JSON.stringify(res.settings));
      toast.success("设置已保存");
    } catch (e) {
      toast.error("保存失败", { description: api.asError(e) });
    } finally {
      setSaving(false);
    }
  }

  function chooseTheme(next: ThemeMode) {
    if (!settings) return;
    setLocalTheme(next);
    setSettings({ ...settings, theme: next });
  }

  function openGithub() {
    void api.api.openExternal("https://github.com/cv-superding/Qoder-Switch2api").catch((e) => {
      toast.error("打开失败", { description: api.asError(e) });
    });
  }

  if (!settings) {
    return (
      <div>
        <PageHeader icon={SlidersHorizontal} title="设置" description="加载本机配置…" />
        {loadError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>设置加载失败</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{loadError}</span>
              <Button size="sm" variant="outline" onClick={() => setReloadKey((key) => key + 1)}>
                <RefreshCw />重试
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl border border-border/70 bg-card/60" />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        icon={SlidersHorizontal}
        title="设置"
        description="外观、客户端路径、自动签到与 API 端点覆盖。所有配置仅保存在本机。"
        actions={
          <>
            {dirty ? <Badge variant="warning" className="h-6 text-[10px]">有未保存的修改</Badge> : null}
            <Button onClick={save} disabled={saving || !dirty}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              保存设置
            </Button>
          </>
        }
      />

      <div className="space-y-4">
        <SectionCard
          icon={Palette}
          title="外观"
          description="主题会立即应用，并同步到桌面端与浏览器。"
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {THEME_OPTIONS.map((option) => {
              const active = theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseTheme(option.value)}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left outline-none transition-[border-color,background-color] focus-visible:ring-2 focus-visible:ring-ring/30",
                    active
                      ? "border-primary/35 bg-primary/[0.045]"
                      : "border-border/80 bg-card hover:border-border hover:bg-muted/30",
                  )}
                >
                  <span className={cn(
                    "inline-flex size-9 items-center justify-center rounded-lg border",
                    active ? "border-primary/20 bg-primary/10 text-primary" : "border-border/70 bg-muted/30 text-muted-foreground",
                  )}>
                    <option.icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-[10.5px] text-muted-foreground">{option.hint}</span>
                  </span>
                  {active ? (
                    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-muted/15 px-4 py-3">
            <div>
              <div className="text-[12.5px] font-medium">关闭窗口时最小化到托盘</div>
              <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                桌面版关闭窗口后继续在系统托盘运行，反代与自动签到保持可用；从托盘菜单可退出。
              </p>
            </div>
            <Switch
              checked={settings.closeToTray}
              onCheckedChange={(v) => setSettings({ ...settings, closeToTray: v })}
              aria-label="关闭窗口时最小化到托盘"
            />
          </div>
        </SectionCard>

        <SectionCard
          icon={FolderGit2}
          title="Qoder 客户端"
          description="留空时自动探测。修改数据目录后请重新检测客户端。"
        >
          <div className="space-y-5">
            {(["domestic", "international"] as Edition[]).map((edition) => {
              const client = clients[edition];
              const editionLabel = edition === "domestic" ? "国内版（Qoder CN）" : "国际版（Qoder）";
              return (
                <div key={edition} className="rounded-xl border border-border/70 bg-muted/15 p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-medium">{editionLabel}</span>
                    {client?.exists ? (
                      <Badge variant="success" className="h-5 text-[10px]">已检测</Badge>
                    ) : (
                      <Badge variant="secondary" className="h-5 text-[10px]">未检测</Badge>
                    )}
                    {client?.authKind ? (
                      <Badge variant="outline" className="h-5 text-[10px] font-normal">登录态：{client.authKind}</Badge>
                    ) : null}
                    {client && client.exists && !client.hasOscryptKey ? (
                      <Badge variant="warning" className="h-5 text-[10px]">密钥不可用</Badge>
                    ) : null}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`dir-${edition}`} className="text-[11.5px]">客户端数据目录</Label>
                      <Input
                        id={`dir-${edition}`}
                        value={settings.clientDirOverrides[edition] ?? ""}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            clientDirOverrides: { ...settings.clientDirOverrides, [edition]: e.target.value },
                          })
                        }
                        placeholder={client?.dir || "留空自动探测"}
                        className="h-9 font-mono text-[10.5px]"
                      />
                      <p className="truncate text-[10px] text-muted-foreground" title={client?.dir}>
                        自动探测：{client?.dir || "—"}
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`exe-${edition}`} className="text-[11.5px]">客户端可执行文件（切换时重启用）</Label>
                      <Input
                        id={`exe-${edition}`}
                        value={settings.clientExePaths[edition] ?? ""}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            clientExePaths: { ...settings.clientExePaths, [edition]: e.target.value },
                          })
                        }
                        placeholder="留空自动探测，例如 D:\\Qoder\\Qoder.exe"
                        className="h-9 font-mono text-[10.5px]"
                      />
                      <p className="truncate text-[10px] text-muted-foreground" title={client?.clientExePath}>
                        自动探测：{client?.clientExePath || "—"}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>

        <SectionCard
          icon={CalendarCheck}
          title="自动签到"
          description="每天在指定时间后为全部启用账号领取 Credits 奖励，重复执行不会重复领取。"
        >
          <div className="flex flex-col gap-4 rounded-xl border border-border/70 bg-muted/15 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[12.5px] font-medium">每日自动签到</div>
              <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                程序在运行时会于设定时间后自动检查，错过整点也会当天补签。
              </p>
            </div>
            <div className="flex items-center gap-3">
              {settings.autoCheckin.enabled ? (
                <div className="flex items-center gap-1.5">
                  <Input
                    id="checkin-hour"
                    type="number"
                    min={0}
                    max={23}
                    value={settings.autoCheckin.hour}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        autoCheckin: { ...settings.autoCheckin, hour: Number(e.target.value) },
                      })
                    }
                    className="h-8 w-16 text-center text-xs tabular-nums"
                  />
                  <span className="text-[10.5px] text-muted-foreground">:00 后执行</span>
                </div>
              ) : null}
              <Switch
                checked={settings.autoCheckin.enabled}
                onCheckedChange={(v) =>
                  setSettings({ ...settings, autoCheckin: { ...settings.autoCheckin, enabled: v } })
                }
                aria-label="每日自动签到"
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          icon={SlidersHorizontal}
          title="API 端点覆盖（高级）"
          description="默认端点已按国内 / 国际分别内置，仅在官方变更域名或企业专属部署时修改。"
          action={
            <Button variant="ghost" size="sm" className="h-8" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "收起" : "展开"}
              <ChevronDown className={cn("transition-transform", showAdvanced && "rotate-180")} />
            </Button>
          }
        >
          {showAdvanced ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {(["domestic", "international"] as Edition[]).map((edition) => (
                <div key={edition} className="space-y-3 rounded-xl border border-border/70 bg-muted/15 p-4">
                  <div className="text-[12.5px] font-medium">{edition === "domestic" ? "国内版（Qoder CN）" : "国际版（Qoder）"}</div>
                  {ENDPOINT_FIELDS.map((field) => (
                    <div key={field.key} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <Label className="text-[11px]">{field.label}</Label>
                        <span className="text-[9.5px] text-muted-foreground">{field.hint}</span>
                      </div>
                      <Input
                        value={settings.endpointOverrides?.[edition]?.[field.key] ?? ""}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            endpointOverrides: {
                              ...settings.endpointOverrides,
                              [edition]: { ...(settings.endpointOverrides?.[edition] ?? {}), [field.key]: e.target.value },
                            },
                          })
                        }
                        placeholder="留空使用默认"
                        className="h-8 font-mono text-[10.5px]"
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">当前使用内置端点。展开可覆盖 client_id、OpenAPI、SSE、模型列表与 Cloud API 地址。</p>
          )}
        </SectionCard>

        <SectionCard
          icon={ShieldCheck}
          title="数据与安全"
          description="账号凭证使用 AES-256-GCM 加密后保存在本机，不会上传到第三方服务器。"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-border/70 bg-muted/15 px-3.5 py-3">
              <div className="text-[10.5px] text-muted-foreground">数据目录</div>
              <div className="mt-1 truncate font-mono text-[11px]">~/.qoder-switch</div>
            </div>
            <div className="rounded-xl border border-border/70 bg-muted/15 px-3.5 py-3">
              <div className="text-[10.5px] text-muted-foreground">账号库</div>
              <div className="mt-1 truncate font-mono text-[11px]">accounts.json（加密）</div>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          icon={Info}
          title="关于"
          description={about?.description ?? "Qoder 多账号切换 + OpenAI / Anthropic 兼容反代"}
          action={
            <Button variant="outline" size="sm" className="h-8" onClick={openGithub}>
              <Github />
              GitHub
              <ExternalLink className="size-3" />
            </Button>
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <Badge variant="secondary" className="h-6 font-mono text-[10px]">{about?.name ?? "Qoder-Switch2api"} v{about?.version ?? "—"}</Badge>
            <span>仅供学习研究使用，请遵守 Qoder 服务条款。</span>
          </div>
          {about?.references?.length ? (
            <div className="mt-3 space-y-1">
              {about.references.map((reference) => (
                <div key={reference} className="flex items-start gap-1.5 text-[10.5px] leading-5 text-muted-foreground">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span className="break-all">{reference}</span>
                </div>
              ))}
            </div>
          ) : null}
        </SectionCard>

        <div className="flex justify-end pb-2">
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            保存设置
          </Button>
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  icon: Icon, title, description, action, children,
}: {
  icon: typeof Sun;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-muted-foreground">
            <Icon className="size-4" strokeWidth={1.8} />
          </span>
          <div>
            <h2 className="text-[13px] font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 max-w-2xl text-[11px] leading-5 text-muted-foreground">{description}</p> : null}
          </div>
        </div>
        {action}
      </div>
      <CardContent className="p-5">{children}</CardContent>
    </Card>
  );
}

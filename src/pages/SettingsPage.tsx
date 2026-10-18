import { useEffect, useState } from "react";
import { FolderOpen, Loader2, Moon, Save, Sun, SunMoon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import * as api from "@/lib/api";
import { applyTheme, type ThemeMode } from "@/lib/theme";
import type { ClientInfo, Edition, Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: SunMoon },
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
  const [saving, setSaving] = useState(false);
  const [about, setAbout] = useState<{ name: string; version: string; description: string; references: string[] } | null>(null);
  const [clients, setClients] = useState<Record<Edition, ClientInfo | null>>({ domestic: null, international: null });

  useEffect(() => {
    Promise.all([api.api.getSettings(), api.api.getAbout()])
      .then(([s, a]) => {
        setSettings(s.settings);
        setAbout(a);
      })
      .catch((e) => toast.error("加载设置失败", { description: api.asError(e) }));
    for (const edition of ["domestic", "international"] as Edition[]) {
      api.api.detectClient(edition).then((res) => setClients((prev) => ({ ...prev, [edition]: res.client }))).catch(() => {});
    }
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      await api.api.saveSettings(settings);
      toast.success("设置已保存");
    } catch (e) {
      toast.error("保存失败", { description: api.asError(e) });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="animate-spin" />
        加载中…
      </div>
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-[28px] font-semibold tracking-tight">设置</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          主题、客户端路径、自动签到与 API 端点覆盖。数据目录：~/.qoder-switch（账号库加密存储）。
        </p>
      </header>

      <div className="space-y-6">
        {/* 外观 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">外观</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setSettings({ ...settings, theme: opt.value });
                    applyTheme(opt.value);
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm transition-colors",
                    settings.theme === opt.value ? "border-primary/60 bg-primary/5 font-medium" : "hover:bg-accent/40",
                  )}
                >
                  <opt.icon className="size-4" />
                  {opt.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 客户端路径 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Qoder 客户端路径</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(["domestic", "international"] as Edition[]).map((edition) => {
              const client = clients[edition];
              return (
                <div key={edition} className="space-y-1.5">
                  <Label htmlFor={`dir-${edition}`} className="text-[13px]">
                    {edition === "domestic" ? "国内版（Qoder CN）" : "国际版（Qoder）"}数据目录
                    {client?.exists ? (
                      <Badge variant="success" className="ml-2 h-5 border-0 px-1.5 text-[10px]">已检测</Badge>
                    ) : (
                      <Badge variant="secondary" className="ml-2 h-5 border-0 px-1.5 text-[10px]">未检测</Badge>
                    )}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id={`dir-${edition}`}
                      value={settings.clientDirOverrides[edition] ?? ""}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          clientDirOverrides: { ...settings.clientDirOverrides, [edition]: e.target.value },
                        })
                      }
                      placeholder={client?.dir || "留空则自动探测"}
                      className="font-mono text-xs"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    自动探测：{client?.dir ?? "—"}
                    {client?.authKind ? ` · 登录态：${client.authKind}` : ""}
                    {client && !client.hasOscryptKey && client.exists ? " · OSCrypt 密钥不可用（仅 Windows 支持自动读写）" : ""}
                  </p>
                </div>
              );
            })}
            <div className="space-y-1.5">
              <Label htmlFor="exe-domestic" className="text-[13px] flex items-center gap-1.5">
                <FolderOpen className="size-3.5" />
                客户端可执行文件（切换时重启用）
              </Label>
              <Input
                id="exe-domestic"
                value={settings.clientExePaths.domestic ?? ""}
                onChange={(e) => setSettings({ ...settings, clientExePaths: { ...settings.clientExePaths, domestic: e.target.value } })}
                placeholder="例如 D:\\Qoder\\Qoder.exe（留空自动探测）"
                className="font-mono text-xs"
              />
            </div>
          </CardContent>
        </Card>

        {/* 自动签到 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">自动签到</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-[13px]">每日自动签到</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">到点自动为全部账号领取每日 Credits 奖励（campaigns 系统，幂等）</p>
              </div>
              <Switch
                checked={settings.autoCheckin.enabled}
                onCheckedChange={(v) => setSettings({ ...settings, autoCheckin: { ...settings.autoCheckin, enabled: v } })}
              />
            </div>
            {settings.autoCheckin.enabled ? (
              <div className="flex items-center gap-2">
                <Label htmlFor="checkin-hour" className="text-[13px]">执行时间（小时）</Label>
                <Input
                  id="checkin-hour"
                  type="number"
                  min={0}
                  max={23}
                  value={settings.autoCheckin.hour}
                  onChange={(e) => setSettings({ ...settings, autoCheckin: { ...settings.autoCheckin, hour: Number(e.target.value) } })}
                  className="h-9 w-20 text-xs"
                />
                <span className="text-xs text-muted-foreground">每天 {String(settings.autoCheckin.hour).padStart(2, "0")}:00 检查</span>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* API 端点覆盖 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">API 端点覆盖（高级）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-xs leading-5 text-muted-foreground">
              默认端点已按国内 / 国际分别内置。仅当 Qoder 官方变更域名或使用企业专属版时才需要修改，留空即可。
            </p>
            {(["domestic", "international"] as Edition[]).map((edition) => (
              <div key={edition} className="space-y-3 rounded-lg border p-4">
                <div className="text-[13px] font-medium">{edition === "domestic" ? "国内版（Qoder CN）" : "国际版（Qoder）"}</div>
                {ENDPOINT_FIELDS.map((field) => (
                  <div key={field.key} className="grid items-center gap-2 sm:grid-cols-[180px_minmax(0,1fr)]">
                    <div>
                      <Label className="text-xs">{field.label}</Label>
                      <p className="text-[10px] text-muted-foreground">{field.hint}</p>
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
                      className="font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* 关于 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">关于</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs leading-5 text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{about?.name ?? "Qoder-Switch2api"}</span> v{about?.version ?? "1.0.0"} —{" "}
              {about?.description}
            </p>
            <p>界面与架构参考：</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {(about?.references ?? []).map((r) => (
                <li key={r} className="break-all">{r}</li>
              ))}
            </ul>
            <p className="pt-1">
              本项目仅供学习研究使用。账号凭证仅保存在本机（AES-256-GCM 加密），不会上传到任何服务器。
              使用多账号切换与反代请遵守 Qoder 服务条款，自行承担相应风险。
            </p>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            保存设置
          </Button>
        </div>
      </div>
    </div>
  );
}

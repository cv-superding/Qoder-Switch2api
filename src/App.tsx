import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { HashRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import {
  BarChart3, Download, Github, Globe2, Loader2, Menu, MessagesSquare, Network, Power, Settings2, Sparkles, Star, Users, X,
} from "lucide-react";
import { toast } from "sonner";

import { AppIconMark, QoderCnMark, QoderMark, StatusDot } from "@/components/product-marks";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import * as api from "@/lib/api";
import { applyTheme, getSavedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useUpdateStore } from "@/stores/update";
import AccountsPage from "@/pages/AccountsPage";
import ApiProxyPage from "@/pages/ApiProxyPage";
import TokenStatsPage from "@/pages/TokenStatsPage";
import CreditStatsPage from "@/pages/CreditStatsPage";
import SessionsPage from "@/pages/SessionsPage";
import SettingsPage from "@/pages/SettingsPage";
import { useAccountsStore } from "@/stores/accounts";

const PAGE_LABELS: Record<string, string> = {
  "/": "账号管理",
  "/credit-stats": "积分统计",
  "/token-stats": "Token 统计",
  "/api-proxy": "API 反代",
  "/api-proxy/domestic": "国内版 API 反代",
  "/api-proxy/international": "国际版 API 反代",
  "/sessions": "会话管理",
  "/settings": "设置",
};

interface NavEntry {
  to: string;
  label: string;
  icon: typeof Users;
  end?: boolean;
  badge?: "accounts" | "domestic" | "international";
}

const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "工作台",
    items: [
      { to: "/", label: "账号管理", icon: Users, end: true, badge: "accounts" },
      { to: "/token-stats", label: "Token 统计", icon: BarChart3 },
      { to: "/credit-stats", label: "积分统计", icon: Sparkles },
    ],
  },
  {
    label: "API 接入",
    items: [
      { to: "/api-proxy/domestic", label: "国内版反代", icon: Network, badge: "domestic" },
      { to: "/api-proxy/international", label: "国际版反代", icon: Globe2, badge: "international" },
    ],
  },
  {
    label: "系统",
    items: [
      { to: "/sessions", label: "会话管理", icon: MessagesSquare },
      { to: "/settings", label: "设置", icon: Settings2 },
    ],
  },
];

function NavItem({ item, onNavigate }: { item: NavEntry; onNavigate?: () => void }) {
  const { status } = useAccountsStore();
  const counts = status?.counts;
  let meta: ReactNode = null;
  if (item.badge === "accounts" && counts) {
    const total = counts.domestic + counts.international;
    if (total > 0) {
      meta = (
        <span className="ml-auto rounded-full bg-white/6 px-1.5 py-0.5 text-[10px] leading-none tabular-nums text-sidebar-foreground/55">
          {total}
        </span>
      );
    }
  } else if (item.badge === "domestic" || item.badge === "international") {
    const edition = status?.editions?.[item.badge];
    const on = Boolean(edition?.proxy.running);
    meta = <span className="ml-auto"><StatusDot on={on} /></span>;
  }

  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group relative flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-[12.5px] font-medium outline-none transition-[background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-sidebar-ring/40",
          isActive
            ? "bg-white/[0.075] text-sidebar-foreground shadow-[inset_0_1px_0_oklch(1_0_0/6%)]"
            : "text-sidebar-foreground/55 hover:bg-white/[0.045] hover:text-sidebar-foreground/90",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              "absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-sidebar-primary transition-opacity",
              isActive ? "opacity-100" : "opacity-0",
            )}
            aria-hidden="true"
          />
          <item.icon
            className={cn(
              "size-[15px] shrink-0 transition-colors",
              isActive ? "text-sidebar-primary" : "text-sidebar-foreground/40 group-hover:text-sidebar-foreground/70",
            )}
            strokeWidth={1.8}
          />
          <span className="truncate">{item.label}</span>
          {meta}
        </>
      )}
    </NavLink>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { status } = useAccountsStore();
  const version = status?.version ?? "—";
  const clientDomestic = status?.editions?.domestic?.client;
  const clientIntl = status?.editions?.international?.client;

  function openGithub() {
    void api.api.openExternal("https://github.com/cv-superding/Qoder-Switch2api").catch(() => {});
  }

  return (
    <div className="sidebar-surface flex h-full min-h-0 w-full flex-col border-r border-sidebar-border">
      <div className="flex h-[68px] shrink-0 items-center gap-3 px-4">
        <span className="inline-flex size-9 items-center justify-center rounded-[11px] bg-white/[0.06] ring-1 ring-white/10">
          <AppIconMark size={26} />
        </span>
        <div className="min-w-0">
          <div className="truncate font-display text-[13.5px] font-semibold leading-5 tracking-[-0.01em] text-sidebar-foreground">
            Qoder-Switch2api
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] leading-none text-sidebar-foreground/40">
            <span className="inline-block size-1 rounded-full bg-emerald-400" />
            本地服务 · 国内 / 国际双版本
          </div>
        </div>
      </div>

      <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4 pt-2">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="mb-1.5 px-2.5 text-[10px] font-medium tracking-[0.08em] text-sidebar-foreground/40">
              {group.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavItem key={item.to} item={item} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border px-3 py-3">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.035] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-medium tracking-[0.06em] text-sidebar-foreground/45">客户端</span>
            <span className="text-[10px] text-sidebar-foreground/40">本机</span>
          </div>
          <div className="space-y-2">
            <ClientRow mark={<QoderCnMark size={16} />} label="Qoder CN" client={clientDomestic} />
            <ClientRow mark={<QoderMark size={16} />} label="Qoder" client={clientIntl} />
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 px-1">
          <span className="font-mono text-[10px] text-sidebar-foreground/40">v{version}</span>
          <div className="flex items-center gap-0.5">
            <ThemeToggle chrome />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={openGithub}
                  aria-label="打开 GitHub 仓库"
                  className="size-8 rounded-lg text-sidebar-foreground/60 hover:bg-white/8 hover:text-sidebar-foreground"
                >
                  <Github className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">GitHub 仓库 · 求个 Star</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

function ClientRow({
  mark, label, client,
}: {
  mark: ReactNode;
  label: string;
  client?: { exists: boolean; authKind: string | null } | null;
}) {
  const detected = Boolean(client?.exists);
  const loggedIn = Boolean(client?.authKind);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="shrink-0 opacity-90">{mark}</span>
      <span className="min-w-0 flex-1 truncate text-sidebar-foreground/70">{label}</span>
      <span className="flex items-center gap-1.5 text-[10px] text-sidebar-foreground/50">
        <StatusDot on={loggedIn} />
        {loggedIn ? "已登录" : detected ? "未登录" : "未安装"}
      </span>
    </div>
  );
}

function GlobalTopbar({ onMenu }: { onMenu: () => void }) {
  const location = useLocation();
  const { status } = useAccountsStore();
  const label = PAGE_LABELS[location.pathname] ?? "Qoder-Switch2api";

  const proxyItems = [
    { key: "domestic" as const, label: "国内", short: "CN" },
    { key: "international" as const, label: "国际", short: "INTL" },
  ];

  return (
    <div className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-background/78 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
      <Button
        variant="ghost"
        size="icon"
        className="-ml-1 size-8 lg:hidden"
        onClick={onMenu}
        aria-label="打开导航"
      >
        <Menu className="size-4" />
      </Button>
      <div className="flex min-w-0 items-center gap-2 text-[12px]">
        <span className="hidden text-muted-foreground sm:inline">控制台</span>
        <span className="hidden text-border sm:inline">/</span>
        <span className="truncate font-medium text-foreground">{label}</span>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <div className="hidden items-center gap-1 md:flex">
          {proxyItems.map((entry) => {
            const edition = status?.editions?.[entry.key];
            const enabled = Boolean(edition?.proxy.enabled);
            const running = Boolean(edition?.proxy.running);
            const error = Boolean(edition?.proxy.error);
            return (
              <NavLink
                key={entry.key}
                to={`/api-proxy/${entry.key}`}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-medium transition-colors",
                  running
                    ? "border-primary/20 bg-primary/[0.07] text-primary"
                    : error
                      ? "border-destructive/25 bg-destructive/[0.06] text-destructive"
                      : "border-border bg-card/60 text-muted-foreground hover:text-foreground",
                )}
                title={`${entry.label}版反代：${running ? "运行中" : enabled ? "未启动" : "未启用"}`}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    running ? "bg-primary" : error ? "bg-destructive" : "bg-muted-foreground/35",
                  )}
                />
                {entry.short} {edition?.proxy.listen?.split(":").pop() ?? "—"}
              </NavLink>
            );
          })}
        </div>
        <div className="mx-1 hidden h-4 w-px bg-border md:block" />
        <ThemeToggle />
      </div>
    </div>
  );
}

const UPDATE_DISMISS_KEY = "qoder-switch2api.update-dismissed";

function openRepo() {
  void api.api.openExternal("https://github.com/cv-superding/Qoder-Switch2api").catch(() => {});
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function UpdateBanner() {
  const {
    info, check, refreshDownload, startDownload, installUpdate,
    downloading, readyToInstall, installing, download, downloadError,
  } = useUpdateStore();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(UPDATE_DISMISS_KEY) || "");
  const notified = useRef("");

  useEffect(() => {
    void check();
    void refreshDownload();
    const timer = window.setInterval(() => void check(), 15 * 60 * 1000);
    // 切回窗口时补一次检查（5 分钟内已尝试过则跳过）
    const maybeCheck = () => {
      const state = useUpdateStore.getState();
      if (!state.checking && Date.now() - state.lastAttemptAt > 5 * 60 * 1000) void check();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") maybeCheck();
    };
    window.addEventListener("focus", maybeCheck);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", maybeCheck);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check, refreshDownload]);

  useEffect(() => {
    if (!info?.hasUpdate || info.latestVersion === dismissed) return;
    if (notified.current === info.latestVersion) return;
    notified.current = info.latestVersion;
    toast.info(`发现新版本 v${info.latestVersion}`, {
      description: `当前 v${info.currentVersion}，可直接在应用内下载并安装。`,
      action: { label: "下载更新", onClick: () => void startDownload() },
      duration: 12000,
    });
  }, [info, dismissed, startDownload]);

  if (!info?.hasUpdate) return null;
  const latest = info.latestVersion;
  if (latest === dismissed) return null;

  const percent = Math.max(0, Math.min(100, download?.percent ?? 0));

  function dismiss() {
    localStorage.setItem(UPDATE_DISMISS_KEY, latest);
    setDismissed(latest);
  }

  async function handleInstall() {
    if (!window.confirm(`将退出当前程序并安装 v${latest}，是否继续？`)) return;
    toast.info("正在退出并安装更新…");
    try {
      await installUpdate();
    } catch (e) {
      toast.error("安装更新失败", { description: api.asError(e) });
    }
  }

  return (
    <div className="shrink-0 border-b border-primary/15 bg-primary/[0.06]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-[11.5px] sm:px-6 lg:px-8">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
          <Download className="size-3.5" />
        </span>
        <span className="font-medium text-foreground">发现新版本 v{info.latestVersion}</span>
        <span className="text-muted-foreground">当前 v{info.currentVersion}</span>
        {downloading ? (
          <span className="text-[10.5px] tabular-nums text-muted-foreground">
            {percent.toFixed(0)}% · {formatBytes(download?.downloaded ?? 0)} / {formatBytes(download?.total ?? 0)}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={openRepo}
            title="打开 GitHub 仓库，求个 Star"
          >
            <Github className="size-3.5" />
            求个 Star
            <Star className="size-3 fill-amber-400 text-amber-500" />
          </Button>
          {readyToInstall ? (
            <Button size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => void handleInstall()} disabled={installing}>
              {installing ? <Loader2 className="size-3.5 animate-spin" /> : <Power className="size-3.5" />}
              {installing ? "正在重启" : "重启并安装"}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => void startDownload()}
              disabled={downloading || installing}
            >
              {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              {downloading ? "下载中" : "下载更新"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={dismiss}
            aria-label="忽略此版本"
            title="忽略此版本"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
      {downloading ? (
        <div className="h-0.5 w-full bg-primary/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
          <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {downloadError ? (
        <div className="px-4 pb-2 text-[10.5px] text-destructive sm:px-6 lg:px-8">下载失败：{downloadError}</div>
      ) : null}
    </div>
  );
}

function Layout() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { status, fetchAll } = useAccountsStore();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!status) void fetchAll();
  }, [status, fetchAll]);

  useEffect(() => {
    if (!getSavedTheme()) {
      void api.api
        .getSettings()
        .then(({ settings }) => applyTheme(settings.theme, { persist: false }))
        .catch(() => {});
    }
  }, []);

  return (
    <div className="flex h-[100dvh] min-h-0 overflow-hidden bg-background">
      <aside className="hidden w-[248px] shrink-0 lg:block">
        <SidebarContent />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="关闭导航"
            className="absolute inset-0 bg-[oklch(0.12_0.02_255/55%)] backdrop-blur-[2px]"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[272px] max-w-[85vw] shadow-2xl">
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2 size-8 text-sidebar-foreground/60 hover:bg-white/10 hover:text-sidebar-foreground"
              onClick={() => setMobileOpen(false)}
              aria-label="关闭导航"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <GlobalTopbar onMenu={() => setMobileOpen(true)} />
        <UpdateBanner />
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
            <div key={location.pathname} className="page-enter">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

/** 页面级错误兜底：避免单个页面崩溃导致整窗白屏 */
class PageErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("页面渲染错误:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-[400px] flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="font-display text-lg font-semibold">页面渲染出错</p>
          <p className="max-w-lg font-mono text-sm text-muted-foreground">{this.state.error}</p>
          <Button
            variant="outline"
            onClick={() => {
              this.setState({ error: null });
              window.location.hash = "#/";
            }}
          >
            返回首页
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <TooltipProvider delayDuration={250}>
      <HashRouter>
        <PageErrorBoundary>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<AccountsPage />} />
              <Route path="/credit-stats" element={<CreditStatsPage />} />
              <Route path="/token-stats" element={<TokenStatsPage />} />
              <Route path="/api-proxy" element={<Navigate to="/api-proxy/domestic" replace />} />
              <Route path="/api-proxy/domestic" element={<ApiProxyPage edition="domestic" />} />
              <Route path="/api-proxy/international" element={<ApiProxyPage edition="international" />} />
              <Route path="/sessions" element={<SessionsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </PageErrorBoundary>
        <Toaster />
      </HashRouter>
    </TooltipProvider>
  );
}

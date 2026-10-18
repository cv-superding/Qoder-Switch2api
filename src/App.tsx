import { useEffect, useState } from "react";
import { HashRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Coins, Globe, MessagesSquare, Network, Settings, Sparkles, User } from "lucide-react";

import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import { AppIconMark, StatusDot } from "@/components/product-marks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

function NavItem({ to, children, end }: { to: string; children: React.ReactNode; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
          isActive
            ? "bg-foreground/[0.06] font-medium text-foreground"
            : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
        )
      }
    >
      {children}
    </NavLink>
  );
}

function ClientStatusSection() {
  const status = useAccountsStore((s) => s.status);
  const running = Boolean(status?.editions?.domestic?.client?.exists);
  return (
    <section className="mt-auto border-t border-sidebar-border px-2 pt-3 text-xs">
      <div className="flex items-center gap-2 text-[13px] text-sidebar-foreground">
        <StatusDot on={running} />
        <span className="min-w-0 flex-1 truncate">Qoder 客户端</span>
        <span className="text-sidebar-foreground/50">v1.0.0</span>
      </div>
    </section>
  );
}

function Layout() {
  const { pathname } = useLocation();
  const pageLabel = PAGE_LABELS[pathname] ?? "Qoder-Switch2api";

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-background">
      <aside className="flex min-h-0 w-[220px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pb-4 pt-4">
        <div className="flex items-center gap-2.5 px-1 pb-5">
          <AppIconMark size={36} className="drop-shadow-sm" />
          <div className="min-w-0">
            <div
              className="truncate text-[15px] leading-5 tracking-[-0.02em] text-sidebar-foreground/90"
              style={{ fontFamily: '"SF Pro Display", ui-sans-serif, sans-serif', fontWeight: 640 }}
            >
              Qoder-Switch2api
            </div>
            <Badge variant="secondary" className="mt-1 h-5 border-0 px-1.5 text-[10px] text-sidebar-foreground/60 shadow-none">
              国内 / 国际双版本
            </Badge>
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5" aria-label="主导航">
          <NavItem to="/" end>
            <User className="size-4" />
            账号管理
          </NavItem>
          <NavItem to="/credit-stats">
            <Sparkles className="size-4" />
            积分统计
          </NavItem>
          <NavItem to="/token-stats">
            <MessagesSquare className="size-4" />
            Token 统计
          </NavItem>
          <NavItem to="/api-proxy/domestic">
            <Network className="size-4" />
            国内版 API 反代
          </NavItem>
          <NavItem to="/api-proxy/international">
            <Globe className="size-4" />
            国际版 API 反代
          </NavItem>
          <NavItem to="/sessions">
            <MessagesSquare className="size-4" />
            会话管理
          </NavItem>
          <NavItem to="/settings">
            <Settings className="size-4" />
            设置
          </NavItem>
        </nav>
        <ClientStatusSection />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto bg-background overscroll-contain">
        <div className="mx-auto w-full max-w-[1180px] px-6 py-8 sm:px-8 sm:py-9">
          <h1 className="sr-only">{pageLabel}</h1>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <TooltipProvider delayDuration={250}>
      <HashRouter>
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
        <Toaster />
      </HashRouter>
    </TooltipProvider>
  );
}

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Columns3, Download, FileDown, FileUp, KeyRound, Loader2, QrCode, RefreshCw, Rows3,
} from "lucide-react";

import { AccountCard } from "@/components/account-card";
import { AddAccountDialog } from "@/components/add-account-dialog";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import { SwitchAccountDialog } from "@/components/switch-account-dialog";
import { ExportAccountsDialog, ImportAccountsDialog } from "@/components/account-backup-dialogs";
import { QoderCnMark, QoderMark, StatusDot } from "@/components/product-marks";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import * as api from "@/lib/api";
import { EDITIONS, accountGroupLabel, type Account, type Edition } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAccountsStore } from "@/stores/accounts";

export default function AccountsPage() {
  const {
    accounts, status, loading, error, fetchAll, deleteAccount, importLocal,
    creditMap, creditLoadingMap, refreshingCredits, ensureCredits, refreshCredits, setAccountGroupLocal,
  } = useAccountsStore();

  const [editionTab, setEditionTab] = useState<Edition>(() => {
    const saved = localStorage.getItem("qoder-switch2api.edition-tab");
    return saved === "international" ? "international" : "domestic";
  });
  const [oauthOpen, setOauthOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [switchAccount, setSwitchAccount] = useState<Account | null>(null);
  const [importing, setImporting] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [checkinMap, setCheckinMap] = useState<Record<string, boolean>>({});
  const [compact, setCompact] = useState<boolean>(() => localStorage.getItem("qoder-switch2api.compact") !== "0");

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (accounts.length === 0) return;
    void ensureCredits(accounts.map((a) => a.id));
  }, [accounts, ensureCredits]);

  const editionAccounts = useMemo(
    () => accounts.filter((a) => (a.edition === "international") === (editionTab === "international")),
    [accounts, editionTab],
  );

  const editionCounts = useMemo(() => {
    const counts = { domestic: 0, international: 0 };
    for (const a of accounts) counts[a.edition === "international" ? "international" : "domestic"] += 1;
    return counts;
  }, [accounts]);

  const editionStatus = status?.editions?.[editionTab];
  const currentUid = editionStatus?.currentAccount?.uid;

  /** 按紧急程度排序：需重登录 > 额度将尽 > 其他 */
  const orderedAccounts = useMemo(() => {
    const rank = (a: Account) => {
      if (a.status === "needs_relogin") return 0;
      const q = creditMap[a.id]?.quota;
      if (q?.remaining != null && q.total != null && q.total > 0 && q.remaining / q.total < 0.1) return 1;
      if (a.cooling) return 2;
      return 3;
    };
    return [...editionAccounts].sort((a, b) => rank(a) - rank(b));
  }, [editionAccounts, creditMap]);

  function switchTab(next: Edition) {
    setEditionTab(next);
    localStorage.setItem("qoder-switch2api.edition-tab", next);
  }

  function toggleCompact() {
    setCompact((v) => {
      localStorage.setItem("qoder-switch2api.compact", v ? "0" : "1");
      return !v;
    });
  }

  async function onImport() {
    setImporting(true);
    try {
      const acc = await importLocal(editionTab);
      toast.success(`已导入本机${editionTab === "domestic" ? "国内版" : "国际版"}账号`, {
        description: acc.name || acc.email || acc.uid,
      });
      void fetchAll();
    } catch (e) {
      toast.error("导入失败", { description: api.asError(e) });
    } finally {
      setImporting(false);
    }
  }

  async function onCheckin(a: Account) {
    try {
      const res = await api.api.checkinAll([a.id]);
      const entry = res.accounts[0];
      if (!entry) return;
      const label = entry.result === "success" ? "签到成功" : entry.result === "already" ? "今天已签到" : "签到失败";
      if (entry.result === "error") toast.error(label, { description: entry.error });
      else toast.success(label, { description: `${entry.name}${entry.rewardCredit ? ` +${entry.rewardCredit} credits` : ""}` });
      if (entry.result !== "error") {
        setCheckinMap((prev) => ({ ...prev, [a.id]: true }));
        void refreshCredits([a.id]);
      }
    } catch (e) {
      toast.error("签到失败", { description: api.asError(e) });
    }
  }

  async function onRefresh(a: Account) {
    try {
      const res = await api.api.refreshToken(a.id);
      toast.success("Token 已刷新", { description: a.name || a.email || a.uid });
      void fetchAll();
      void refreshCredits([a.id]);
    } catch (e) {
      toast.error("Token 刷新失败", { description: api.asError(e) });
    }
  }

  async function onDelete(a: Account) {
    try {
      await deleteAccount(a.id);
      toast.success("账号已删除");
    } catch (e) {
      toast.error("删除失败", { description: api.asError(e) });
    }
  }

  async function onSetGroup(a: Account, group: string) {
    try {
      await api.api.updateAccount(a.id, { group });
      setAccountGroupLocal(a.id, group);
      toast.success("分组已更新", { description: `${a.name || a.uid} → ${accountGroupLabel(group)}` });
    } catch (e) {
      toast.error("分组设置失败", { description: api.asError(e) });
    }
  }

  async function onRefreshCredits() {
    if (editionAccounts.length === 0) return;
    try {
      const res = await api.api.checkinAll(editionAccounts.map((a) => a.id));
      const success = res.accounts.filter((e) => e.result === "success").length;
      const already = res.accounts.filter((e) => e.result === "already").length;
      const failed = res.accounts.filter((e) => e.result === "error").length;
      const parts: string[] = [];
      if (success > 0) parts.push(`${success} 个签到成功`);
      if (already > 0) parts.push(`${already} 个已签到`);
      if (failed > 0) parts.push(`${failed} 个失败`);
      toast.success("批量签到完成", { description: parts.join("，") || "无账号需要签到" });
      const next: Record<string, boolean> = {};
      for (const e of res.accounts) if (e.result !== "error") next[e.id] = true;
      setCheckinMap((prev) => ({ ...prev, ...next }));
    } catch (e) {
      toast.error("批量签到失败", { description: api.asError(e) });
    }
    await refreshCredits(editionAccounts.map((a) => a.id));
    toast.success("积分已刷新");
  }

  const client = editionStatus?.client;

  return (
    <div>
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold tracking-tight">账号管理</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              统一管理 Qoder（国内版 Qoder CN / 国际版）账号、额度、签到与客户端切换。两个版本账号体系完全独立。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2.5 pt-1">
            <span className="group relative inline-flex cursor-default">
              <span className={cn("inline-flex rounded-[22%] p-[2px]", client?.exists ? "bg-primary shadow-sm shadow-primary/40" : "bg-muted-foreground/30")}>
                <QoderCnMark size={28} />
              </span>
              <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5 group-hover:block">
                Qoder CN：{client?.exists ? (client.authKind ? "已检测到登录态" : "未登录") : "未安装"}
              </span>
            </span>
            <span className="group relative inline-flex cursor-default">
              <span className={cn("inline-flex rounded-[22%] p-[2px]", status?.editions?.international?.client?.exists ? "bg-primary shadow-sm shadow-primary/40" : "bg-muted-foreground/30")}>
                <QoderMark size={28} />
              </span>
              <span className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden whitespace-nowrap rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg ring-1 ring-black/5 group-hover:block">
                Qoder 国际版：{status?.editions?.international?.client?.exists ? "已检测到登录态" : "未安装"}
              </span>
            </span>
          </div>
        </div>
      </header>

      {/* 添加与迁移账号 */}
      <div className="relative mb-6 overflow-visible rounded-2xl border border-border bg-muted/30 px-5 py-5 shadow-[0_6px_20px_rgba(15,23,42,.025)]">
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
          <div className="absolute -right-12 -top-20 size-44 rounded-full border-[28px] border-slate-400/[0.035]" />
        </div>
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-4">
          <div className="min-w-[190px] flex-1">
            <h2 className="text-sm font-semibold text-foreground">添加与迁移账号</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              当前目标版本：<span className="font-medium text-foreground">{editionTab === "domestic" ? "国内版（Qoder CN）" : "国际版（Qoder）"}</span>
              {client?.dir ? (
                <>
                  <br />
                  客户端目录：<code className="text-[10px]">{client.dir}</code>
                  {client.authKind ? `（${client.authKind}）` : "（未检测到登录态）"}
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button className="h-10 bg-primary px-4 text-primary-foreground shadow-sm hover:bg-primary/90" onClick={() => setOauthOpen(true)}>
              <QrCode />扫码添加（{editionTab === "domestic" ? "国内版" : "国际版"}）
            </Button>
            <Button className="h-10 px-4" onClick={onImport} disabled={importing} variant="outline">
              {importing ? <Loader2 className="animate-spin" /> : <Download />}
              导入本机账号
            </Button>
            <Button className="h-10 px-4" onClick={() => setAddOpen(true)} variant="outline">
              <KeyRound />手动添加
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-9 px-2.5" onClick={() => setImportOpen(true)} title="从备份文件导入账号">
              <FileUp />导入备份
            </Button>
            <Button variant="ghost" size="sm" className="h-9 px-2.5" onClick={() => setExportOpen(true)} disabled={accounts.length === 0} title="导出账号备份">
              <FileDown />导出
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {client?.exists && !client.hasOscryptKey ? (
        <Alert className="mb-4">
          <AlertTitle>客户端登录态读取受限</AlertTitle>
          <AlertDescription>
            检测到客户端目录但无法解出 OSCrypt 密钥。Windows 下需要 DPAPI（在本机运行即可）；macOS / Linux
            的密钥在系统钥匙串中，暂不支持自动读写，可改用「扫码添加」或「手动添加」。
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="mt-7 min-w-0" aria-labelledby="accounts-list-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="accounts-list-title" className="text-base font-semibold tracking-tight">账号</h2>
            <div role="tablist" aria-label="客户端版本" className="ml-1 inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
              {EDITIONS.map((e) => {
                const active = editionTab === e.value;
                return (
                  <button
                    key={e.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchTab(e.value)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {e.label}
                    <span className={cn("rounded-full px-1.5 text-[10px] tabular-nums", active ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                      {editionCounts[e.value]}
                    </span>
                  </button>
                );
              })}
            </div>
            <Badge variant="secondary" className="h-6 min-w-6 rounded-full border-0 px-1.5 text-[11px] tabular-nums text-muted-foreground shadow-none">
              {editionAccounts.length}
            </Badge>
          </div>
          <TooltipProvider delayDuration={400}>
            <div className="ml-auto flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className={cn("size-9 rounded-lg", compact && "bg-accent text-accent-foreground")} onClick={toggleCompact} aria-label="切换紧凑模式">
                    {compact ? <Rows3 /> : <Columns3 />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{compact ? "切换为宽松模式" : "切换为紧凑模式"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-9 rounded-lg"
                    disabled={refreshingCredits || editionAccounts.length === 0}
                    onClick={() => void onRefreshCredits()}
                    aria-label="批量签到并刷新积分"
                  >
                    <RefreshCw className={refreshingCredits ? "animate-spin" : undefined} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">批量签到并刷新全部账号积分</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>

        {loading && accounts.length === 0 ? (
          <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="animate-spin" />
            加载账号…
          </div>
        ) : editionAccounts.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
            {accounts.length === 0
              ? "暂无账号。点击上方按钮导入本机账号、扫码登录或手动添加。"
              : `暂无${editionTab === "domestic" ? "国内版" : "国际版"}账号。切换上方版本标签查看另一版本，或点击「扫码添加 / 导入本机账号」。`}
          </div>
        ) : (
          <div className={cn("grid min-w-0 items-start gap-5", compact ? "grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))]" : "grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))]")}>
            {orderedAccounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                compact={compact}
                credit={creditMap[a.id]}
                creditLoading={creditLoadingMap[a.id]}
                creditPriority={false}
                clientActive={Boolean(currentUid && a.uid === currentUid)}
                clientBusy={switchingId !== null}
                clientLoading={switchingId === a.id}
                todayCheckedIn={checkinMap[a.id]}
                onSwitch={(acc) => {
                  setSwitchAccount(acc);
                  setSwitchingId(acc.id);
                }}
                onDelete={onDelete}
                onRefresh={onRefresh}
                onCheckin={onCheckin}
                onSetGroup={onSetGroup}
              />
            ))}
          </div>
        )}
      </section>

      <OAuthLoginDialog
        open={oauthOpen}
        onOpenChange={setOauthOpen}
        edition={editionTab}
        onDone={() => void fetchAll()}
      />
      <AddAccountDialog open={addOpen} onOpenChange={setAddOpen} edition={editionTab} onDone={() => void fetchAll()} />
      <ExportAccountsDialog open={exportOpen} onOpenChange={setExportOpen} accounts={accounts} onExported={() => {}} />
      <ImportAccountsDialog open={importOpen} onOpenChange={setImportOpen} onImported={() => void fetchAll()} />
      <SwitchAccountDialog
        open={switchAccount !== null}
        onOpenChange={(o) => {
          if (!o) {
            setSwitchAccount(null);
            setSwitchingId(null);
          }
        }}
        account={switchAccount}
        onDone={() => {
          void fetchAll();
          setSwitchingId(null);
        }}
      />
    </div>
  );
}

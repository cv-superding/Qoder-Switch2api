import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Columns3, Download, FileDown, FileUp, KeyRound, Loader2, LogIn, MoreHorizontal, Network, RefreshCw, Rows3,
  ShieldAlert, TriangleAlert, UserRoundCheck, Users,
} from "lucide-react";
import { Link } from "react-router-dom";

import { AccountCard } from "@/components/account-card";
import { AddAccountDialog } from "@/components/add-account-dialog";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import { SwitchAccountDialog } from "@/components/switch-account-dialog";
import { ExportAccountsDialog, ImportAccountsDialog } from "@/components/account-backup-dialogs";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QoderCnMark, QoderMark } from "@/components/product-marks";
import { Segmented } from "@/components/segmented";
import { StatCard } from "@/components/stat-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import * as api from "@/lib/api";
import { accountGroupLabel, type Account, type Edition } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAccountsStore } from "@/stores/accounts";

export default function AccountsPage() {
  const {
    accounts, status, loading, error, fetchAll, deleteAccount, importLocal,
    creditMap, creditLoadingMap, creditErrorMap, refreshingCredits, ensureCredits, refreshCredits, setAccountGroupLocal,
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
  const [compact, setCompact] = useState<boolean>(() => localStorage.getItem("qoder-switch2api.compact") === "1");

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (accounts.length === 0) return;
    void ensureCredits(accounts.map((a) => a.id));
  }, [accounts, ensureCredits]);

  useEffect(() => {
    void api.api
      .getCheckinLogs()
      .then((res) => {
        const today = new Date().toDateString();
        const next: Record<string, boolean> = {};
        for (const log of res.logs ?? []) {
          const ts = Number(log.ts);
          const accountId = String(log.accountId ?? "");
          const result = String(log.result ?? "");
          if (!accountId || !ts || new Date(ts).toDateString() !== today) continue;
          if (result === "success" || result === "replayed" || result === "already") next[accountId] = true;
        }
        setCheckinMap(next);
      })
      .catch(() => {});
  }, []);

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
  const proxyAvailable = (status?.counts.proxyDomestic ?? 0) + (status?.counts.proxyInternational ?? 0);
  const detectedClients = [status?.editions?.domestic?.client, status?.editions?.international?.client].filter(
    (client) => client?.exists,
  ).length;
  const needsAttention = accounts.filter(
    (a) => a.status === "needs_relogin" || a.cooling || (typeof a.tokenExpireAt === "number" && a.tokenExpireAt < Date.now()),
  ).length;
  const checkedToday = editionAccounts.filter((a) => checkinMap[a.id]).length;

  /** 按紧急程度排序：需重登录 > 额度将尽 > 冷却中 > 其他 */
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
      const next = !v;
      localStorage.setItem("qoder-switch2api.compact", next ? "1" : "0");
      return next;
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

  function markCheckedIn(id: string) {
    setCheckinMap((prev) => ({ ...prev, [id]: true }));
  }

  async function onCheckin(a: Account) {
    try {
      const res = await api.api.checkinAll([a.id]);
      const entry = res.accounts[0];
      if (!entry) return;
      if (entry.result === "success") {
        toast.success("签到成功", {
          description: `${entry.name}${entry.rewardCredit ? ` +${entry.rewardCredit} credits` : ""}`,
        });
        markCheckedIn(a.id);
        void refreshCredits([a.id]);
      } else if (entry.result === "already") {
        toast.info("今天已签到", { description: entry.name });
        markCheckedIn(a.id);
        void refreshCredits([a.id]);
      } else if (entry.result === "none") {
        toast.info("暂无可签到活动", { description: entry.error || "该账号当前没有可领取的奖励" });
      } else {
        toast.error("签到失败", { description: entry.error });
      }
    } catch (e) {
      toast.error("签到失败", { description: api.asError(e) });
    }
  }

  async function onRefresh(a: Account) {
    try {
      await api.api.refreshToken(a.id);
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
      void fetchAll();
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
    let success = 0;
    let already = 0;
    let none = 0;
    let failed = 0;
    try {
      const res = await api.api.checkinAll(editionAccounts.map((a) => a.id));
      success = res.accounts.filter((e) => e.result === "success").length;
      already = res.accounts.filter((e) => e.result === "already").length;
      none = res.accounts.filter((e) => e.result === "none").length;
      failed = res.accounts.filter((e) => e.result === "error").length;
      const parts: string[] = [];
      if (success > 0) parts.push(`${success} 个签到成功`);
      if (already > 0) parts.push(`${already} 个今日已签`);
      if (none > 0) parts.push(`${none} 个无可领取活动`);
      if (failed > 0) parts.push(`${failed} 个失败`);
      const next: Record<string, boolean> = {};
      for (const entry of res.accounts) {
        if (entry.result === "success" || entry.result === "already") next[entry.id] = true;
      }
      setCheckinMap((prev) => ({ ...prev, ...next }));
      const description = parts.join("，") || "没有需要处理的账号";
      if (failed > 0 && success + already === 0) toast.error("批量签到失败", { description });
      else toast.success("批量签到完成", { description });
    } catch (e) {
      toast.error("批量签到失败", { description: api.asError(e) });
    }
    await refreshCredits(editionAccounts.map((a) => a.id));
  }

  const client = editionStatus?.client;
  const editionLabel = editionTab === "domestic" ? "国内版" : "国际版";

  return (
    <div>
      <PageHeader
        icon={Users}
        title="账号管理"
        description="集中管理国内版 Qoder CN 与国际版 Qoder 账号，处理登录态切换、额度刷新、每日签到与反代分组。"
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="更多账号操作" className="size-9">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>添加账号</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setAddOpen(true)}>
                  <KeyRound />手动添加
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onImport} disabled={importing}>
                  <Download />导入本机账号
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>备份与迁移</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setImportOpen(true)}>
                  <FileUp />导入备份
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setExportOpen(true)} disabled={accounts.length === 0}>
                  <FileDown />导出备份
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => setAddOpen(true)} variant="outline" className="hidden sm:inline-flex">
              <KeyRound />手动添加
            </Button>
            <Button onClick={onImport} disabled={importing} variant="outline" className="hidden sm:inline-flex">
              {importing ? <Loader2 className="animate-spin" /> : <Download />}
              导入本机账号
            </Button>
            <Button onClick={() => setOauthOpen(true)}>
              <LogIn />OAuth 登录
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
        <StatCard
          label="账号总数"
          value={accounts.length}
          icon={Users}
          hint={`国内 ${editionCounts.domestic} · 国际 ${editionCounts.international}`}
        />
        <StatCard
          label="反代可用"
          value={proxyAvailable}
          icon={Network}
          tone="sky"
          hint="已加入反代账号池"
        />
        <StatCard
          label="客户端检测"
          value={`${detectedClients} / 2`}
          icon={UserRoundCheck}
          tone={detectedClients > 0 ? "brand" : "neutral"}
          hint={detectedClients > 0 ? "本机客户端已就绪" : "未检测到 Qoder 客户端"}
        />
        <StatCard
          label="需要处理"
          value={needsAttention}
          icon={ShieldAlert}
          tone={needsAttention > 0 ? "amber" : "neutral"}
          hint={needsAttention > 0 ? "需重登录 / 冷却 / Token 过期" : "所有账号状态正常"}
        />
      </div>

      {error ? (
        <Alert variant="destructive" className="mb-4">
          <TriangleAlert />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {client?.exists && !client.hasOscryptKey ? (
        <Alert className="mb-4">
          <ShieldAlert />
          <AlertTitle>客户端登录态读取受限</AlertTitle>
          <AlertDescription>
            检测到客户端目录但无法解出 OSCrypt 密钥。Windows 下需要 DPAPI，在本机运行即可；macOS / Linux
            的密钥存放在系统钥匙串中，暂不支持自动读写，可改用 OAuth 登录或手动添加账号。
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="accounts-list-title">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 id="accounts-list-title" className="sr-only">账号列表</h2>
          <Segmented
            ariaLabel="客户端版本"
            value={editionTab}
            onChange={(next) => switchTab(next as Edition)}
            options={[
              {
                value: "domestic",
                label: "国内版",
                count: editionCounts.domestic,
                icon: <QoderCnMark size={14} />,
              },
              {
                value: "international",
                label: "国际版",
                count: editionCounts.international,
                icon: <QoderMark size={14} />,
              },
            ]}
          />

          <div className="hidden min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground xl:flex">
            <span className="text-border">|</span>
            <span className="truncate font-mono text-[10.5px]" title={client?.dir}>
              {client?.dir || "未检测到客户端目录"}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="mr-1 hidden text-[11px] text-muted-foreground sm:inline">
              {editionLabel} · 今日已签 {checkedToday}
            </span>
            <TooltipProvider delayDuration={350}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("size-8 rounded-lg", compact && "bg-accent text-accent-foreground")}
                    onClick={toggleCompact}
                    aria-label={compact ? "切换为宽松模式" : "切换为紧凑模式"}
                  >
                    {compact ? <Rows3 /> : <Columns3 />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{compact ? "切换为宽松模式" : "切换为紧凑模式"}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={refreshingCredits || editionAccounts.length === 0}
              onClick={() => void onRefreshCredits()}
            >
              <RefreshCw className={cn(refreshingCredits && "animate-spin")} />
              批量签到
            </Button>
          </div>
        </div>

        {loading && accounts.length === 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[226px] animate-pulse rounded-2xl border border-border/70 bg-card/60" />
            ))}
          </div>
        ) : editionAccounts.length === 0 ? (
          <EmptyState
            icon={Users}
            title={`还没有${editionLabel}账号`}
            description={
              accounts.length === 0
                ? "从本机 Qoder 客户端导入登录态，或通过 OAuth 登录、手动输入 Token 添加账号。"
                : `当前只添加了另一版本的账号。切换到上方版本标签查看，或添加${editionLabel}账号。`
            }
            action={
              <>
                <Button onClick={() => setOauthOpen(true)}>
                  <LogIn />OAuth 登录
                </Button>
                <Button variant="outline" onClick={onImport} disabled={importing}>
                  {importing ? <Loader2 className="animate-spin" /> : <Download />}
                  导入本机账号
                </Button>
                <Button variant="ghost" asChild>
                  <Link to="/settings">配置客户端路径</Link>
                </Button>
              </>
            }
          />
        ) : (
          <div
            className={cn(
              "min-w-0",
              compact
                ? "flex flex-col gap-2"
                : "grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-4",
            )}
          >
            {orderedAccounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                compact={compact}
                credit={creditMap[a.id]}
                creditLoading={creditLoadingMap[a.id]}
                creditError={creditErrorMap[a.id]}
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
                onRefreshCredit={(acc) => void refreshCredits([acc.id])}
                onSetGroup={onSetGroup}
              />
            ))}
          </div>
        )}
      </section>

      <OAuthLoginDialog open={oauthOpen} onOpenChange={setOauthOpen} edition={editionTab} onDone={() => void fetchAll()} />
      <AddAccountDialog open={addOpen} onOpenChange={setAddOpen} edition={editionTab} onDone={() => void fetchAll()} />
      <ExportAccountsDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        accounts={accounts}
        onExported={() => {}}
      />
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

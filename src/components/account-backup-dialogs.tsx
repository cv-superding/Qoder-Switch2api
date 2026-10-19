import { useEffect, useState } from "react";
import { Download, FileDown, FileUp, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/api";
import type { Account } from "@/lib/types";

/** 导出账号备份（脱敏提示 + JSON 下载） */
export function ExportAccountsDialog({
  open, onOpenChange, accounts, onExported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accounts: Account[];
  onExported: (count: number) => void;
}) {
  const [includeTokens, setIncludeTokens] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (open) setIncludeTokens(false);
  }, [open]);

  async function doExport() {
    setExporting(true);
    try {
      const payload = {
        app: "qoder-switch2api",
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts: accounts.map((a) => ({
          edition: a.edition,
          label: a.label,
          name: a.name,
          email: a.email,
          phone: a.phone,
          uid: a.uid,
          userType: a.userType,
          orgId: a.orgId,
          orgName: a.orgName,
          group: a.group,
          machineId: a.machineId,
          authSource: a.authSource,
          ...(includeTokens
            ? {
                securityOauthToken: undefined,
                refreshToken: undefined,
                pat: undefined,
                note: "导出工具不会读取明文 token，请使用「含登录态」完整备份需在服务端进行",
              }
            : {}),
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `qoder-switch2api-accounts-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      onExported(accounts.length);
      onOpenChange(false);
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileDown className="size-5" />
            导出账号备份
          </DialogTitle>
          <DialogDescription>
            导出的文件包含账号基本信息（不含明文 token）。账号的完整登录态保存在本机
            <code className="mx-1 rounded bg-muted px-1">~/.qoder-switch/accounts.json</code>（加密存储），
            换机器迁移时请直接拷贝该文件。
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-xs leading-5 text-muted-foreground">
          共 {accounts.length} 个账号：
          <span className="mx-1">国内版 {accounts.filter((a) => a.edition === "domestic").length}</span> /
          <span className="mx-1">国际版 {accounts.filter((a) => a.edition === "international").length}</span>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          账号凭证等同密码。请勿将备份文件上传网盘或发送给他人。
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={doExport} disabled={exporting || accounts.length === 0}>
            {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            导出 JSON
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 从备份文件导入账号（基本信息；token 需重新登录获取） */
export function ImportAccountsDialog({
  open, onOpenChange, onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);

  async function doImport() {
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const list = Array.isArray(json?.accounts) ? json.accounts : [];
      if (list.length === 0) throw new Error("文件中没有可导入的账号");
      let imported = 0;
      for (const item of list) {
        try {
          await api.api.addAccount({
            edition: item.edition === "international" ? "international" : "domestic",
            label: item.label || "",
            name: item.name || "",
            email: item.email || "",
            phone: item.phone || "",
            uid: item.uid || "",
            userType: item.userType || "",
            orgId: item.orgId || "",
            orgName: item.orgName || "",
            group: item.group || "",
            machineId: item.machineId || "",
            authSource: "backup",
            pat: item.pat || undefined,
            securityOauthToken: item.securityOauthToken || undefined,
            refreshToken: item.refreshToken || undefined,
          });
          imported += 1;
        } catch {
          /* 跳过无法导入的条目 */
        }
      }
      toast.success(`导入完成：${imported} 个账号`, {
        description: "不含登录态的账号需要重新登录或刷新后才能使用反代。",
      });
      onImported();
      onOpenChange(false);
    } catch (e) {
      toast.error("导入失败", { description: api.asError(e) });
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="size-5" />
            导入账号备份
          </DialogTitle>
          <DialogDescription>
            选择本工具导出的 JSON 备份文件。若备份包含登录态字段会一并导入，否则导入后需重新登录。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full cursor-pointer rounded-lg border border-input bg-transparent p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-xs file:font-medium"
          />
          {file ? <div className="text-xs text-muted-foreground">已选择：{file.name}</div> : null}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={doImport} disabled={importing || !file}>
            {importing ? <Loader2 className="animate-spin" /> : <FileUp />}
            导入
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

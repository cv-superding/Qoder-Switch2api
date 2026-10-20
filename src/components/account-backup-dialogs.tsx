import { useEffect, useMemo, useState } from "react";
import { Download, FileDown, FileUp, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import * as api from "@/lib/api";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 导出账号备份（可选包含完整登录态） */
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
    if (open) {
      setIncludeTokens(false);
      setExporting(false);
    }
  }, [open]);

  async function doExport() {
    setExporting(true);
    try {
      const payload = await api.api.exportAccounts({ includeTokens });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `qoder-switch2api-accounts-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`已导出 ${payload.accounts.length} 个账号`, {
        description: includeTokens ? "备份包含完整登录态，请妥善保管" : "备份仅包含账号信息，不含 Token",
      });
      onExported(payload.accounts.length);
      onOpenChange(false);
    } catch (e) {
      toast.error("导出失败", { description: api.asError(e) });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileDown className="size-5 text-primary" />
            导出账号备份
          </DialogTitle>
          <DialogDescription>
            生成 JSON 备份文件，可在另一台机器上通过「导入备份」恢复账号。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-border/80 bg-muted/30 px-3.5 py-3">
            <div className="text-[11px] text-muted-foreground">国内版账号</div>
            <div className="mt-1 font-display text-xl font-semibold tabular-nums">
              {accounts.filter((a) => a.edition === "domestic").length}
            </div>
          </div>
          <div className="rounded-xl border border-border/80 bg-muted/30 px-3.5 py-3">
            <div className="text-[11px] text-muted-foreground">国际版账号</div>
            <div className="mt-1 font-display text-xl font-semibold tabular-nums">
              {accounts.filter((a) => a.edition === "international").length}
            </div>
          </div>
        </div>

        <div
          className={cn(
            "flex items-start gap-3 rounded-xl border px-4 py-3.5 transition-colors",
            includeTokens ? "border-amber-500/35 bg-amber-500/[0.06]" : "border-border/80 bg-muted/25",
          )}
        >
          <ShieldCheck className={cn("mt-0.5 size-4 shrink-0", includeTokens ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium">包含完整登录态</div>
            <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
              包含 Token 与 refresh token，导入后无需重新登录。备份文件等同密码，请勿上传网盘或发送给他人。
            </p>
          </div>
          <Switch checked={includeTokens} onCheckedChange={setIncludeTokens} aria-label="包含完整登录态" />
        </div>

        {includeTokens ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            敏感文件仅保存在本机，使用完成后建议删除。
          </div>
        ) : null}

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

/** 从备份文件导入账号（支持含登录态 / 不含登录态两种备份） */
export function ImportAccountsDialog({
  open, onOpenChange, onImported,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [parseError, setParseError] = useState("");
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (open) {
      setFile(null);
      setRows([]);
      setParseError("");
      setImporting(false);
    }
  }, [open]);

  const withTokens = useMemo(
    () => rows.filter((row) => Boolean(row.securityOauthToken || row.pat)).length,
    [rows],
  );

  async function pickFile(next: File | null) {
    setFile(next);
    setRows([]);
    setParseError("");
    if (!next) return;
    try {
      const json = JSON.parse(await next.text());
      const list = Array.isArray(json?.accounts) ? json.accounts : [];
      if (list.length === 0) throw new Error("文件中没有可导入的账号");
      setRows(list);
    } catch (e) {
      setParseError(api.asError(e));
    }
  }

  async function doImport() {
    if (rows.length === 0) return;
    setImporting(true);
    try {
      const result = await api.api.importAccounts(rows);
      const skipped = result.skipped.length;
      if (result.imported === 0) {
        toast.error("没有账号被导入", {
          description: skipped > 0 ? result.skipped[0]?.error : "请确认备份包含登录凭证",
        });
      } else {
        toast.success(`已导入 ${result.imported} 个账号`, {
          description: skipped > 0 ? `${skipped} 个条目因缺少登录态被跳过` : undefined,
        });
        onImported();
        onOpenChange(false);
      }
    } catch (e) {
      toast.error("导入失败", { description: api.asError(e) });
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="size-5 text-primary" />
            导入账号备份
          </DialogTitle>
          <DialogDescription>
            选择由本工具导出的 JSON 备份。含登录态的条目可直接使用，其余条目会创建为待登录账号。
          </DialogDescription>
        </DialogHeader>

        <label
          htmlFor="backup-file"
          className={cn(
            "dot-grid flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-5 py-8 text-center transition-colors hover:border-primary/40 hover:bg-primary/[0.02]",
            file ? "border-primary/35 bg-primary/[0.025]" : "border-border bg-muted/20",
          )}
        >
          <span className="mb-2 inline-flex size-10 items-center justify-center rounded-xl border border-border/80 bg-card text-muted-foreground">
            <FileUp className="size-4" />
          </span>
          <span className="text-[12.5px] font-medium">{file ? file.name : "点击选择备份文件"}</span>
          <span className="mt-1 text-[11px] text-muted-foreground">
            {file
              ? `${rows.length} 个账号，其中 ${withTokens} 个包含登录态`
              : "支持 .json 文件"}
          </span>
          <input
            id="backup-file"
            type="file"
            accept=".json,application/json"
            className="sr-only"
            onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
          />
        </label>

        {parseError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-[11.5px] text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            {parseError}
          </div>
        ) : null}

        {rows.length > 0 && withTokens === 0 ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[11.5px] text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            该备份不含 Token，将导入为待登录账号。重新登录或导入本机账号后即可恢复使用。
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={doImport} disabled={importing || rows.length === 0}>
            {importing ? <Loader2 className="animate-spin" /> : <FileUp />}
            导入 {rows.length > 0 ? `${rows.length} 个` : ""}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

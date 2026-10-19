import { useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as api from "@/lib/api";
import { editionLabel, type Account, type Edition } from "@/lib/types";

/** 手动添加账号：PAT（Cloud Agents）或 IDE 登录态 token */
export function AddAccountDialog({
  open, onOpenChange, edition, onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  edition: Edition;
  onDone: (a: Account) => void;
}) {
  const [mode, setMode] = useState<"pat" | "token">("pat");
  const [pat, setPat] = useState("");
  const [token, setToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [uid, setUid] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setPat("");
      setToken("");
      setRefreshToken("");
      setUid("");
      setLabel("");
    }
  }, [open]);

  async function submit() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { edition, label };
      if (mode === "pat") {
        if (!pat.trim()) throw new Error("请填写 PAT");
        body.pat = pat.trim();
      } else {
        if (!token.trim()) throw new Error("请填写 securityOauthToken");
        body.securityOauthToken = token.trim();
        body.refreshToken = refreshToken.trim();
        body.uid = uid.trim();
      }
      const res = await api.api.addAccount(body);
      toast.success(`${editionLabel(edition)}账号已添加`);
      onDone(res.account);
      onOpenChange(false);
    } catch (e) {
      toast.error("添加失败", { description: api.asError(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>手动添加{editionLabel(edition)}账号</DialogTitle>
          <DialogDescription>
            适合无法扫码登录的场景：粘贴 PAT（Cloud Agents API）或从其他工具导出的 IDE 登录态 token。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg border bg-muted/40 p-0.5">
          <button
            type="button"
            onClick={() => setMode("pat")}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${mode === "pat" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
          >
            PAT（Cloud Agents）
          </button>
          <button
            type="button"
            onClick={() => setMode("token")}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${mode === "token" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
          >
            IDE 登录态 Token
          </button>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="acc-label">备注名（可选）</Label>
            <Input id="acc-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：主力号 / 小号1" />
          </div>

          {mode === "pat" ? (
            <div className="space-y-1.5">
              <Label htmlFor="acc-pat">Personal Access Token</Label>
              <Input
                id="acc-pat"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="pt-..."
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                在 Qoder 控制台 Settings → Personal Access Tokens 创建。PAT 走 Cloud Agents API，与 IDE
                登录态相互独立。
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="acc-token">securityOauthToken</Label>
                <Input
                  id="acc-token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="dt-..."
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acc-refresh">refreshToken（可选，用于自动续期）</Label>
                <Input
                  id="acc-refresh"
                  value={refreshToken}
                  onChange={(e) => setRefreshToken(e.target.value)}
                  placeholder="drt-..."
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="acc-uid">UID / 用户 ID（可选）</Label>
                <Input id="acc-uid" value={uid} onChange={(e) => setUid(e.target.value)} className="font-mono text-xs" />
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
            添加
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

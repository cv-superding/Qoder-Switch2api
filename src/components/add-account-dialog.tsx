import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as api from "@/lib/api";
import { editionLabel, type Account, type Edition } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMode("pat");
      setPat("");
      setToken("");
      setRefreshToken("");
      setUid("");
      setLabel("");
      setSaving(false);
      setVisible(false);
    }
  }, [open]);

  async function submit() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { edition, label: label.trim() };
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-primary" />
            手动添加{editionLabel(edition)}账号
          </DialogTitle>
          <DialogDescription>
            适合无法使用 OAuth 登录的场景。PAT 走 Cloud Agents API，IDE 登录态用于 Cosy 流式通道。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          {[
            { value: "pat" as const, title: "PAT", hint: "Cloud Agents API Token", icon: ShieldCheck },
            { value: "token" as const, title: "IDE 登录态", hint: "securityOauthToken", icon: KeyRound },
          ].map((option) => {
            const active = mode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                className={cn(
                  "flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-left outline-none transition-[border-color,background-color] focus-visible:ring-2 focus-visible:ring-ring/30",
                  active ? "border-primary/35 bg-primary/[0.045]" : "border-border/80 hover:bg-muted/30",
                )}
              >
                <option.icon className={cn("mt-0.5 size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                <span>
                  <span className="block text-[12px] font-medium">{option.title}</span>
                  <span className="mt-0.5 block text-[10.5px] text-muted-foreground">{option.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="acc-label" className="text-[12px]">备注名（可选）</Label>
            <Input id="acc-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：主力号 / 备用号" />
          </div>

          {mode === "pat" ? (
            <div className="space-y-1.5">
              <Label htmlFor="acc-pat" className="text-[12px]">Personal Access Token</Label>
              <div className="relative">
                <Input
                  id="acc-pat"
                  type={visible ? "text" : "password"}
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                  placeholder="pt-..."
                  className="pr-9 font-mono text-xs"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  className="absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={visible ? "隐藏 Token" : "显示 Token"}
                >
                  {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
              <p className="text-[10.5px] leading-5 text-muted-foreground">
                在 Qoder 控制台 Settings → Personal Access Tokens 创建，与 IDE 登录态相互独立。
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="acc-token" className="text-[12px]">securityOauthToken</Label>
                <div className="relative">
                  <Input
                    id="acc-token"
                    type={visible ? "text" : "password"}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="dt-..."
                    className="pr-9 font-mono text-xs"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setVisible((v) => !v)}
                    className="absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={visible ? "隐藏 Token" : "显示 Token"}
                  >
                    {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="acc-refresh" className="text-[12px]">refreshToken（可选）</Label>
                  <Input
                    id="acc-refresh"
                    type={visible ? "text" : "password"}
                    value={refreshToken}
                    onChange={(e) => setRefreshToken(e.target.value)}
                    placeholder="drt-..."
                    className="font-mono text-xs"
                    autoComplete="off"
                  />
                  <p className="text-[10px] text-muted-foreground">用于自动续期。</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="acc-uid" className="text-[12px]">UID（可选）</Label>
                  <Input id="acc-uid" value={uid} onChange={(e) => setUid(e.target.value)} className="font-mono text-xs" placeholder="重复添加时用于去重" />
                  <p className="text-[10px] text-muted-foreground">留空时按 ID 独立保存。</p>
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
            添加账号
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

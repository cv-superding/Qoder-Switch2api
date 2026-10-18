import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, QrCode } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/api";
import { editionLabel, type Account, type Edition } from "@/lib/types";

/** OAuth 设备流登录对话框：展示验证 URL，轮询等待授权 */
export function OAuthLoginDialog({
  open, onOpenChange, edition, onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  edition: Edition;
  onDone: (a: Account) => void;
}) {
  const [loginId, setLoginId] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    let cancelled = false;
    setStatus("idle");
    setError("");
    setVerificationUri("");
    setLoginId("");
    void (async () => {
      try {
        const res = await api.api.oauthStart(edition);
        if (cancelled) return;
        setLoginId(res.loginId);
        setVerificationUri(res.verificationUri);
        setStatus("pending");
        // 尝试自动打开浏览器
        window.open(res.verificationUri, "_blank", "noopener,noreferrer");
        pollRef.current = window.setInterval(async () => {
          try {
            const poll = await api.api.oauthPoll(res.loginId);
            if (cancelled) return;
            if (poll.status === "done" && poll.account) {
              window.clearInterval(pollRef.current!);
              pollRef.current = null;
              setStatus("done");
              toast.success(`${editionLabel(edition)}账号登录成功`, {
                description: poll.account.name || poll.account.email || poll.account.uid,
              });
              onDone(poll.account);
              onOpenChange(false);
            } else if (poll.status === "error") {
              window.clearInterval(pollRef.current!);
              pollRef.current = null;
              setStatus("error");
              setError(poll.error || "登录失败");
            }
          } catch (e) {
            if (!cancelled) {
              window.clearInterval(pollRef.current!);
              pollRef.current = null;
              setStatus("error");
              setError(api.asError(e));
            }
          }
        }, 2000);
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(api.asError(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, edition, onDone, onOpenChange]);

  async function copyUri() {
    try {
      await navigator.clipboard.writeText(verificationUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("复制失败，请手动选择复制");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="size-5" />
            扫码添加{editionLabel(edition)}账号
          </DialogTitle>
          <DialogDescription>
            通过 Qoder 官方 OAuth 设备流登录。点击下方按钮在浏览器中打开授权页，完成登录后账号会自动加入账号库。
          </DialogDescription>
        </DialogHeader>

        {status === "error" ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">授权链接</div>
            <div className="break-all font-mono text-xs leading-5">
              {verificationUri || "生成中…"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              className="flex-1"
              disabled={!verificationUri}
              onClick={() => window.open(verificationUri, "_blank", "noopener,noreferrer")}
            >
              打开授权页面
            </Button>
            <Button variant="outline" disabled={!verificationUri} onClick={copyUri}>
              {copied ? <Check /> : <Copy />}
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            {status === "pending" ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                等待授权中…（轮询中，有效期 10 分钟）
              </>
            ) : status === "done" ? (
              <>
                <Check className="size-3.5 text-emerald-500" />
                登录成功
              </>
            ) : status === "idle" ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                正在创建登录会话…
              </>
            ) : null}
          </div>
        </div>

        <DialogDescription className="text-xs">
          提示：{editionLabel(edition)}账号需使用对应版本的 Qoder 账号登录（国内版走阿里云账号体系，国际版走
          GitHub / Google / 邮箱），两个版本的账号不互通。
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

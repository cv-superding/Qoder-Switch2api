import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, LogIn, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { QoderCnMark, QoderMark } from "@/components/product-marks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/api";
import { editionLabel, type Account, type Edition } from "@/lib/types";
import { cn } from "@/lib/utils";

async function openInBrowser(url: string) {
  try {
    await api.api.openExternal(url);
    return;
  } catch {
    /* 后端不可用时退回 window.open（浏览器场景仍有效） */
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** OAuth 设备流登录对话框：提供授权链接并轮询结果 */
export function OAuthLoginDialog({
  open, onOpenChange, edition, onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  edition: Edition;
  onDone: (a: Account) => void;
}) {
  const [verificationUri, setVerificationUri] = useState("");
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);
  const loginIdRef = useRef("");
  const onDoneRef = useRef(onDone);
  const onOpenChangeRef = useRef(onOpenChange);

  useEffect(() => {
    onDoneRef.current = onDone;
    onOpenChangeRef.current = onOpenChange;
  }, [onDone, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("idle");
    setError("");
    setVerificationUri("");
    setCopied(false);
    loginIdRef.current = "";

    void (async () => {
      try {
        const res = await api.api.oauthStart(edition);
        if (cancelled) {
          void api.api.oauthCancel(res.loginId).catch(() => {});
          return;
        }
        loginIdRef.current = res.loginId;
        setVerificationUri(res.verificationUri);
        setStatus("pending");
        void openInBrowser(res.verificationUri);
        pollRef.current = window.setInterval(async () => {
          try {
            const poll = await api.api.oauthPoll(res.loginId);
            if (cancelled) return;
            if (poll.status === "done" && poll.account) {
              if (pollRef.current) window.clearInterval(pollRef.current);
              pollRef.current = null;
              loginIdRef.current = "";
              setStatus("done");
              toast.success(`${editionLabel(edition)}账号登录成功`, {
                description: poll.account.name || poll.account.email || poll.account.uid,
              });
              onDoneRef.current(poll.account);
              onOpenChangeRef.current(false);
            } else if (poll.status === "error") {
              if (pollRef.current) window.clearInterval(pollRef.current);
              pollRef.current = null;
              setStatus("error");
              setError(poll.error || "登录失败");
            }
          } catch (e) {
            if (!cancelled) {
              if (pollRef.current) window.clearInterval(pollRef.current);
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
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (loginIdRef.current) {
        void api.api.oauthCancel(loginIdRef.current).catch(() => {});
        loginIdRef.current = "";
      }
    };
  }, [open, edition]);

  async function copyUri() {
    try {
      await navigator.clipboard.writeText(verificationUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("复制失败，请手动选择复制");
    }
  }

  const Mark = edition === "domestic" ? QoderCnMark : QoderMark;

  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChangeRef.current(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="inline-flex size-8 items-center justify-center rounded-lg border border-border/80 bg-muted/30">
              <LogIn className="size-4 text-primary" />
            </span>
            OAuth 登录{editionLabel(edition)}账号
          </DialogTitle>
          <DialogDescription>
            通过 Qoder 官方设备流授权。打开链接完成登录后，账号会自动加入账号库，无需复制 Token。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-xl border border-border/80 bg-muted/20 px-3 py-2.5">
          <Mark size={20} />
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] font-medium">{edition === "domestic" ? "Qoder CN" : "Qoder 国际版"}</div>
            <div className="text-[10px] text-muted-foreground">
              {edition === "domestic" ? "阿里云账号体系" : "GitHub / Google / 邮箱"}
            </div>
          </div>
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className={cn(
              "size-1.5 rounded-full",
              status === "pending" ? "animate-pulse bg-amber-500" : status === "done" ? "bg-primary" : status === "error" ? "bg-destructive" : "bg-muted-foreground/40",
            )} />
            {status === "pending" ? "等待授权" : status === "done" ? "已登录" : status === "error" ? "失败" : "准备中"}
          </span>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">授权链接</span>
            {verificationUri ? (
              <button
                type="button"
                onClick={copyUri}
                className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
              >
                {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
                {copied ? "已复制" : "复制链接"}
              </button>
            ) : null}
          </div>
          <div className="min-h-[64px] break-all rounded-xl border border-border/80 bg-muted/25 px-3 py-2.5 font-mono text-[10.5px] leading-5 text-muted-foreground">
            {verificationUri || (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" />
                正在创建登录会话…
              </span>
            )}
          </div>
        </div>

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.05] px-3.5 py-2.5 text-[11.5px] text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="grid grid-cols-[auto_1fr] items-center gap-2.5 rounded-xl border border-border/70 bg-card px-3.5 py-3">
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
            {status === "done" ? <Check className="size-3.5" /> : <LogIn className="size-3.5" />}
          </span>
          <div className="text-[10.5px] leading-5 text-muted-foreground">
            {status === "done"
              ? "登录成功，正在关闭对话框。"
              : "在浏览器中完成登录后保持本窗口开启，通常 3 到 10 秒内自动完成。"}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] leading-4 text-muted-foreground">
            两个版本的账号体系完全独立，不能交叉登录。
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" onClick={() => onOpenChangeRef.current(false)}>
              {status === "pending" ? "取消" : "关闭"}
            </Button>
            <Button
              disabled={!verificationUri || status === "done"}
              onClick={() => void openInBrowser(verificationUri)}
            >
              <ExternalLink />
              打开授权页
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

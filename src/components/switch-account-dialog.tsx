import { useEffect, useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/api";
import { editionLabel, type Account } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Step {
  name: string;
  status: string;
  detail?: string;
}

/** 客户端切换对话框：备份 → 结束进程 → 写入账号 → 重启 */
export function SwitchAccountDialog({
  open, onOpenChange, account, onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account: Account | null;
  onDone: () => void;
}) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState("");

  useEffect(() => {
    if (!open || !account) {
      setSteps([]);
      setDone(false);
      setError("");
      setJobId("");
      return;
    }
    let cancelled = false;
    let poller: number | null = null;
    void (async () => {
      try {
        const res = await api.api.switchAccount(account.id, true);
        if (cancelled) return;
        setJobId(res.jobId);
        poller = window.setInterval(async () => {
          try {
            const job = await api.api.switchJob(res.jobId);
            if (cancelled) return;
            setSteps(job.steps);
            if (job.done) {
              window.clearInterval(poller!);
              poller = null;
              if (job.error) {
                setError(job.error);
              } else {
                setDone(true);
                onDone();
              }
            }
          } catch (e) {
            if (!cancelled) {
              window.clearInterval(poller!);
              poller = null;
              setError(api.asError(e));
            }
          }
        }, 600);
      } catch (e) {
        if (!cancelled) setError(api.asError(e));
      }
    })();
    return () => {
      cancelled = true;
      if (poller) window.clearInterval(poller);
    };
  }, [open, account, onDone]);

  const running = steps.some((s) => s.status === "running");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>切换 Qoder 客户端账号</DialogTitle>
          <DialogDescription>
            将 {editionLabel(account?.edition ?? "domestic")} 客户端的登录账号切换为
            「{account?.name || account?.email || account?.uid}」，客户端会自动重启。
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-2.5">
          {steps.length === 0 && !error ? (
            <li className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 正在启动…
            </li>
          ) : null}
          {steps.map((step, i) => (
            <li key={`${step.name}-${i}`} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 shrink-0">
                {step.status === "done" ? (
                  <Check className="size-4 text-emerald-500" strokeWidth={2.5} />
                ) : step.status === "error" ? (
                  <TriangleAlert className="size-4 text-destructive" />
                ) : (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("font-medium", step.status === "error" && "text-destructive")}>{step.name}</span>
                {step.detail ? <span className="ml-2 text-xs text-muted-foreground">{step.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>

        {error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {done ? (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
            切换完成，客户端正在以新账号启动。
          </div>
        ) : null}

        <DialogDescription className="text-xs">
          原理：备份客户端登录态（auth.v1.dat / state.vscdb）→ 结束 Qoder 进程 → 写入目标账号凭证 →
          重新启动客户端。备份文件保留在客户端数据目录中。
        </DialogDescription>

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            {done || error ? "关闭" : "取消"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

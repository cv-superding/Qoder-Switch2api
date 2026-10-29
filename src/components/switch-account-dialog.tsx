import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, Check, Loader2, TriangleAlert } from "lucide-react";

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

/** 后端会把同一步骤的 running / done 都推过来，按名称合并只保留最新状态 */
function dedupeSteps(list: Step[]): Step[] {
  const order: string[] = [];
  const map = new Map<string, Step>();
  for (const step of list) {
    if (!map.has(step.name)) order.push(step.name);
    map.set(step.name, step);
  }
  return order.map((name) => map.get(name)!);
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
  const onDoneRef = useRef(onDone);
  const accountId = account?.id ?? "";

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!open || !accountId) {
      setSteps([]);
      setDone(false);
      setError("");
      return;
    }
    let cancelled = false;
    let poller: number | null = null;
    setSteps([]);
    setDone(false);
    setError("");

    void (async () => {
      try {
        const res = await api.api.switchAccount(accountId, true);
        if (cancelled) return;
        poller = window.setInterval(async () => {
          try {
            const job = await api.api.switchJob(res.jobId);
            if (cancelled) return;
            setSteps(dedupeSteps(job.steps));
            if (job.done) {
              if (poller) window.clearInterval(poller);
              poller = null;
              if (job.error) {
                setError(job.error);
              } else {
                setDone(true);
                onDoneRef.current();
              }
            }
          } catch (e) {
            if (!cancelled) {
              if (poller) window.clearInterval(poller);
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
  }, [open, accountId]);

  const running = steps.some((s) => s.status === "running");
  const completed = steps.filter((s) => s.status === "done").length;
  const restartFailed = steps.some((s) => s.name === "重启 Qoder" && s.status === "error");
  const progress = steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 切换任务执行中不允许关闭，避免误以为已取消而实际客户端仍在被修改
        if (!next && !done && !error) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-5 text-primary" />
            切换客户端账号
          </DialogTitle>
          <DialogDescription>
            将 {editionLabel(account?.edition ?? "domestic")} 客户端切换为
            「{account?.name || account?.email || account?.uid}」，完成后会自动重启 Qoder。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
            <span>{done ? "切换完成" : error ? "切换失败" : "正在切换"}</span>
            <span className="tabular-nums">{completed} / {Math.max(steps.length, 4)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                error ? "bg-destructive" : done ? "bg-primary" : "bg-primary/70",
              )}
              style={{ width: `${done && !restartFailed ? 100 : Math.max(progress, steps.length > 0 ? 8 : 4)}%` }}
            />
          </div>
        </div>

        <ol className="space-y-0.5 rounded-xl border border-border/70 bg-muted/15 p-2" aria-live="polite">
          {steps.length === 0 && !error ? (
            <li className="flex items-center gap-2.5 px-2 py-2.5 text-[12px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 正在创建切换任务…
            </li>
          ) : null}
          {steps.map((step, i) => (
            <li key={`${step.name}-${i}`} className="relative flex items-start gap-2.5 rounded-lg px-2 py-2">
              {i < steps.length - 1 ? (
                <span className="absolute left-[15px] top-7 h-[calc(100%_-_12px)] w-px bg-border" aria-hidden="true" />
              ) : null}
              <span className="relative z-10 mt-0.5 shrink-0">
                {step.status === "done" ? (
                  <span className="inline-flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="size-2.5" strokeWidth={3.5} />
                  </span>
                ) : step.status === "error" ? (
                  <TriangleAlert className="size-4 text-destructive" />
                ) : (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("text-[12px] font-medium", step.status === "error" && "text-destructive")}>{step.name}</span>
                {step.detail ? <span className="mt-0.5 block break-all text-[10.5px] leading-5 text-muted-foreground">{step.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.05] px-3.5 py-2.5 text-[11.5px] text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {done ? (
          restartFailed ? (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5 text-[11.5px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>登录态已写入，但客户端未能自动启动，请手动打开 Qoder。</span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/[0.05] px-3.5 py-2.5 text-[11.5px] text-primary">
              <Check className="mt-0.5 size-3.5 shrink-0" />
              <span>登录态已写入，客户端正在以新账号启动。</span>
            </div>
          )
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] leading-4 text-muted-foreground">
            会先备份 auth.v1.dat / state.vscdb，备份文件保留在客户端数据目录。
          </p>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            {done || error ? "关闭" : running ? "切换中…" : "取消"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

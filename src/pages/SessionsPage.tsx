import { useEffect, useState } from "react";
import { Download, FolderGit2, Loader2, MessagesSquare, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Segmented } from "@/components/segmented";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import * as api from "@/lib/api";
import type { ChatItem, Edition, Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 会话管理：发现本地 Qoder 工作区与聊天历史，支持导出 */
export default function SessionsPage() {
  const [edition, setEdition] = useState<Edition>("domestic");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [exportingId, setExportingId] = useState("");

  async function loadWorkspaces() {
    setLoading(true);
    setError("");
    setSelected("");
    setChats([]);
    try {
      const res = await api.api.listWorkspaces(edition);
      setWorkspaces(res.workspaces ?? []);
    } catch (e) {
      setError(api.asError(e));
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadWorkspaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edition]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setChatsLoading(true);
    api.api
      .getChats(edition, selected)
      .then((res) => {
        if (!cancelled) setChats(res.chats ?? []);
      })
      .catch((e) => {
        if (!cancelled) {
          setChats([]);
          toast.error("读取聊天历史失败", { description: api.asError(e) });
        }
      })
      .finally(() => {
        if (!cancelled) setChatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [edition, selected]);

  async function onExport(ws: Workspace) {
    setExportingId(ws.id);
    try {
      const res = await api.api.exportChats(edition, ws.id);
      toast.success(`已导出 ${res.count} 条会话`, { description: res.mdPath });
    } catch (e) {
      toast.error("导出失败", { description: api.asError(e) });
    } finally {
      setExportingId("");
    }
  }

  const selectedWorkspace = workspaces.find((w) => w.id === selected);
  const editionLabel = edition === "domestic" ? "国内版" : "国际版";

  return (
    <div>
      <PageHeader
        icon={MessagesSquare}
        title="会话管理"
        description="扫描本机 Qoder 客户端的工作区与聊天历史，可导出为 JSON / Markdown 备份。"
        actions={
          <>
            <Segmented
              ariaLabel="客户端版本"
              value={edition}
              onChange={setEdition}
              options={[
                { value: "domestic", label: "国内版" },
                { value: "international", label: "国际版" },
              ]}
            />
            <Button variant="ghost" size="icon" className="size-9" onClick={() => void loadWorkspaces()} disabled={loading} aria-label="重新扫描工作区">
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      {error ? (
        <Alert variant="destructive" className="mb-5">
          <TriangleAlert />
          <AlertTitle>读取工作区失败</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void loadWorkspaces()}>重试</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <div className="h-[480px] animate-pulse rounded-2xl border border-border/70 bg-card/60" />
          <div className="h-[480px] animate-pulse rounded-2xl border border-border/70 bg-card/60" />
        </div>
      ) : workspaces.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title={`未发现${editionLabel}工作区`}
          description="请确认本机已安装并运行过对应版本的 Qoder 客户端，且客户端数据目录未被移动。"
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
              <div>
                <h2 className="text-[13px] font-semibold">工作区</h2>
                <p className="mt-0.5 text-[10.5px] text-muted-foreground">{workspaces.length} 个本地项目</p>
              </div>
              <Badge variant="secondary" className="h-5 text-[10px]">{editionLabel}</Badge>
            </div>
            <div className="max-h-[560px] space-y-1 overflow-y-auto p-2">
              {workspaces.map((ws) => {
                const active = selected === ws.id;
                return (
                  <div
                    key={ws.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelected(ws.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(ws.id);
                      }
                    }}
                    className={cn(
                      "group relative flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/30",
                      active
                        ? "border-primary/25 bg-primary/[0.05]"
                        : "border-transparent hover:border-border/70 hover:bg-muted/30",
                    )}
                  >
                    {active ? <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-primary" /> : null}
                    <span
                      className={cn(
                        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border",
                        active ? "border-primary/20 bg-card text-primary" : "border-border/70 bg-muted/30 text-muted-foreground",
                      )}
                    >
                      <FolderGit2 className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium" title={ws.name}>{ws.name}</div>
                      <div className="mt-0.5 truncate font-mono text-[9.5px] text-muted-foreground" title={ws.path}>
                        {ws.path || "—"}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-[10px] tabular-nums text-muted-foreground">{ws.chatCount} 条</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 rounded-md opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onExport(ws);
                        }}
                        disabled={exportingId === ws.id}
                        aria-label={`导出 ${ws.name}`}
                      >
                        {exportingId === ws.id ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border/70 px-5 py-3.5">
              <div className="min-w-0">
                <h2 className="truncate text-[13px] font-semibold">
                  {selectedWorkspace ? selectedWorkspace.name : "聊天历史"}
                </h2>
                <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                  {selectedWorkspace ? `${chats.length} 条记录` : "从左侧选择一个工作区"}
                </p>
              </div>
              {selectedWorkspace ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0"
                  onClick={() => void onExport(selectedWorkspace)}
                  disabled={exportingId === selectedWorkspace.id}
                >
                  {exportingId === selectedWorkspace.id ? <Loader2 className="animate-spin" /> : <Download />}
                  导出工作区
                </Button>
              ) : null}
            </div>

            {!selected ? (
              <EmptyState
                compact
                icon={MessagesSquare}
                title="尚未选择工作区"
                description="选择左侧工作区后，这里会显示对应的聊天历史与上下文文件。"
                className="m-5 border-0 bg-transparent"
              />
            ) : chatsLoading ? (
              <div className="space-y-2 p-4">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-xl border border-border/60 bg-muted/30" />
                ))}
              </div>
            ) : chats.length === 0 ? (
              <EmptyState
                compact
                icon={MessagesSquare}
                title="该工作区暂无聊天记录"
                description="换一个工作区，或先在 Qoder 客户端中开始一次对话。"
                className="m-5 border-0 bg-transparent"
              />
            ) : (
              <div className="max-h-[560px] space-y-1.5 overflow-y-auto p-3">
                {chats.map((chat) => (
                  <div key={chat.id} className="rounded-xl border border-border/70 bg-muted/15 px-3.5 py-2.5 transition-colors hover:bg-muted/30">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={chat.title}>{chat.title}</span>
                      <span className="shrink-0 text-[9.5px] tabular-nums text-muted-foreground">
                        {chat.timestamp
                          ? new Date(chat.timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
                          : "—"}
                      </span>
                    </div>
                    {chat.contexts.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {(chat.contexts ?? []).slice(0, 5).map((c) => (
                          <span key={c.id} className="max-w-[180px] truncate rounded-md border border-border/70 bg-card px-1.5 py-0.5 text-[9.5px] text-muted-foreground">
                            {c.name || c.type || c.id.slice(0, 8)}
                          </span>
                        ))}
                        {chat.contexts.length > 5 ? (
                          <span className="px-1 text-[9.5px] text-muted-foreground">+{chat.contexts.length - 5}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

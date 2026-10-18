import { useEffect, useState } from "react";
import { Download, Loader2, MessagesSquare } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import * as api from "@/lib/api";
import type { ChatItem, Edition, Workspace } from "@/lib/types";

/** 会话管理：发现本地 Qoder 工作区与聊天历史，支持导出 */
export default function SessionsPage() {
  const [edition, setEdition] = useState<Edition>("domestic");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);

  useEffect(() => {
    setSelected("");
    setChats([]);
    setLoading(true);
    api.api
      .listWorkspaces(edition)
      .then((res) => setWorkspaces(res.workspaces))
      .catch((e) => toast.error("读取工作区失败", { description: api.asError(e) }))
      .finally(() => setLoading(false));
  }, [edition]);

  useEffect(() => {
    if (!selected) return;
    setChatsLoading(true);
    api.api
      .getChats(edition, selected)
      .then((res) => setChats(res.chats))
      .catch((e) => toast.error("读取聊天历史失败", { description: api.asError(e) }))
      .finally(() => setChatsLoading(false));
  }, [edition, selected]);

  async function onExport(ws: Workspace) {
    try {
      const res = await api.api.exportChats(edition, ws.id);
      toast.success(`已导出 ${res.count} 条会话`, { description: res.mdPath });
    } catch (e) {
      toast.error("导出失败", { description: api.asError(e) });
    }
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-[28px] font-semibold tracking-tight">会话管理</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          发现本机 Qoder 客户端的工作区与聊天历史（来自 workspaceStorage 与 state.vscdb），可导出为 JSON / Markdown 备份。
        </p>
      </header>

      <div className="mb-6 inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
        {(["domestic", "international"] as Edition[]).map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => setEdition(e)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${edition === e ? "bg-background shadow-sm" : "text-muted-foreground"}`}
          >
            {e === "domestic" ? "国内版（Qoder CN）" : "国际版（Qoder）"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="animate-spin" />
          扫描工作区…
        </div>
      ) : workspaces.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
          未发现工作区。请确认本机已安装并运行过对应版本的 Qoder 客户端。
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {/* 工作区列表 */}
          <div className="space-y-3">
            <h2 className="text-sm font-semibold">工作区（{workspaces.length}）</h2>
            {workspaces.map((ws) => (
              <Card
                key={ws.id}
                className={`cursor-pointer transition-colors ${selected === ws.id ? "border-primary/60 bg-primary/[0.03]" : "hover:bg-accent/40"}`}
                onClick={() => setSelected(ws.id)}
              >
                <CardContent className="flex items-center gap-3 py-3.5">
                  <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{ws.name}</div>
                    <div className="truncate text-xs text-muted-foreground" title={ws.path}>{ws.path || "—"}</div>
                  </div>
                  <Badge variant="secondary" className="h-5 shrink-0 border-0 px-1.5 text-[10px] tabular-nums">
                    {ws.chatCount} 条
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onExport(ws);
                    }}
                    aria-label={`导出 ${ws.name}`}
                  >
                    <Download className="size-3.5" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* 聊天历史 */}
          <div>
            <h2 className="mb-3 text-sm font-semibold">
              聊天历史{selected ? `（${chats.length}）` : ""}
            </h2>
            {!selected ? (
              <div className="rounded-xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
                选择左侧工作区查看聊天历史
              </div>
            ) : chatsLoading ? (
              <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="animate-spin" />
                读取中…
              </div>
            ) : chats.length === 0 ? (
              <div className="rounded-xl border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">
                该工作区暂无聊天记录
              </div>
            ) : (
              <div className="max-h-[560px] space-y-2 overflow-y-auto rounded-xl border p-3">
                {chats.map((chat) => (
                  <div key={chat.id} className="rounded-lg border bg-muted/30 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{chat.title}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {chat.timestamp ? new Date(chat.timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                      </span>
                    </div>
                    {chat.contexts.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {chat.contexts.slice(0, 4).map((c) => (
                          <span key={c.id} className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {c.name || c.type || c.id.slice(0, 8)}
                          </span>
                        ))}
                        {chat.contexts.length > 4 ? (
                          <span className="text-[10px] text-muted-foreground">+{chat.contexts.length - 4}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

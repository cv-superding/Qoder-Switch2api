/**
 * Qoder 客户端会话管理：工作区发现、聊天历史读取、导出备份。
 * 数据来源：User/workspaceStorage 下的 workspace.json 与
 * User/globalStorage/state.vscdb 的 lingma.chat.localHistory.{workspaceId}。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveClientDir, workspaceStorageDir, globalStorageDb, dataDir } from "./paths.js";
import { EDITIONS } from "./editions.js";

let sqliteMod = null;
async function getSqlite() {
  if (sqliteMod !== null) return sqliteMod;
  try {
    sqliteMod = await import("node:sqlite");
  } catch {
    sqliteMod = null;
  }
  return sqliteMod;
}

function decodeWorkspacePath(folderUri) {
  if (!folderUri) return "";
  try {
    if (folderUri.startsWith("file://")) {
      const u = new URL(folderUri);
      return decodeURIComponent(u.pathname).replace(/^\/([a-zA-Z]):/, "$1:");
    }
  } catch {
    /* ignore */
  }
  return folderUri;
}

function lastSegment(p) {
  if (!p) return "";
  const cleaned = p.replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

/** 列出工作区（有聊天记录的排前面） */
export async function listWorkspaces(editionValue, settings = {}) {
  const edition = EDITIONS[editionValue] || EDITIONS.domestic;
  const dir = resolveClientDir(edition, settings.clientDirOverrides?.[editionValue]);
  const wsDir = workspaceStorageDir(dir);
  if (!fs.existsSync(wsDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const wsJson = path.join(wsDir, entry.name, "workspace.json");
    if (!fs.existsSync(wsJson)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(wsJson, "utf8"));
      const folder = decodeWorkspacePath(json.folder);
      const name = lastSegment(folder) || json.workspace?.name || `未命名-${entry.name.slice(0, 8)}`;
      out.push({ id: entry.name, name, path: folder, chatCount: 0 });
    } catch {
      /* skip */
    }
  }
  // 聊天记录数量
  const db = globalStorageDb(dir);
  const sqlite = await getSqlite();
  if (fs.existsSync(db) && sqlite) {
    try {
      const database = new sqlite.DatabaseSync(db, { readOnly: true });
      try {
        for (const ws of out) {
          try {
            const row = database
              .prepare("SELECT value FROM ItemTable WHERE key = ?")
              .get(`lingma.chat.localHistory.${ws.id}`);
            if (row?.value) {
              const history = JSON.parse(String(row.value));
              ws.chatCount = Array.isArray(history) ? history.length : 0;
            }
          } catch {
            /* ignore */
          }
        }
      } finally {
        database.close();
      }
    } catch {
      /* ignore */
    }
  }
  out.sort((a, b) => b.chatCount - a.chatCount || a.name.localeCompare(b.name));
  return out;
}

/** 读取指定工作区的聊天历史 */
export async function getChatHistory(editionValue, workspaceId, settings = {}) {
  const edition = EDITIONS[editionValue] || EDITIONS.domestic;
  const dir = resolveClientDir(edition, settings.clientDirOverrides?.[editionValue]);
  const db = globalStorageDb(dir);
  if (!fs.existsSync(db)) return [];
  const sqlite = await getSqlite();
  if (!sqlite) throw new Error("当前 Node 不支持 node:sqlite，无法读取会话（请用 Node >= 22.5 启动）");
  const database = new sqlite.DatabaseSync(db, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(`lingma.chat.localHistory.${workspaceId}`);
    if (!row?.value) return [];
    const history = JSON.parse(String(row.value));
    return (Array.isArray(history) ? history : []).map((h) => ({
      id: h.id || "",
      title: h.title || "未命名对话",
      timestamp: h.timestamp ?? null,
      sessionId: h.sessionId || "",
      contexts: (h.context || []).map((c) => ({ id: c.id || "", name: c.name || "", type: c.type || "" })),
    }));
  } finally {
    database.close();
  }
}

/** 导出聊天历史为 JSON + Markdown，返回文件路径 */
export async function exportChatHistory(editionValue, workspaceId, settings = {}) {
  const chats = await getChatHistory(editionValue, workspaceId, settings);
  const exportDir = path.join(dataDir(), "exports");
  fs.mkdirSync(exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(exportDir, `qoder-chats-${workspaceId}-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(chats, null, 2), "utf8");
  const mdPath = path.join(exportDir, `qoder-chats-${workspaceId}-${stamp}.md`);
  const lines = [`# Qoder 会话导出（工作区 ${workspaceId}）`, ""];
  for (const chat of chats) {
    const when = chat.timestamp ? new Date(chat.timestamp).toLocaleString("zh-CN") : "未知时间";
    lines.push(`## ${chat.title}`, "", `- 时间：${when}`, `- 会话 ID：${chat.sessionId || "—"}`, "");
    if (chat.contexts.length > 0) {
      lines.push("上下文：");
      for (const c of chat.contexts) lines.push(`- ${c.name || c.id}（${c.type || "unknown"}）`);
      lines.push("");
    }
  }
  fs.writeFileSync(mdPath, lines.join("\n"), "utf8");
  return { jsonPath, mdPath, count: chats.length };
}

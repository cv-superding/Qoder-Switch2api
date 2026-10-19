//! Qoder 客户端会话管理：工作区发现、聊天历史读取、导出备份。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::editions::Edition;
use crate::paths::{global_storage_db, resolve_client_dir, workspace_storage_dir};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: String,
    pub chat_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatItem {
    pub id: String,
    pub title: String,
    pub timestamp: Option<i64>,
    pub session_id: String,
    pub contexts: Vec<Value>,
}

fn decode_workspace_path(folder_uri: &str) -> String {
    if folder_uri.is_empty() {
        return String::new();
    }
    if let Ok(u) = url::Url::parse(folder_uri) {
        let mut path = u.path().to_string();
        // file:///C:/xxx → C:/xxx
        if path.len() > 2 && path.as_bytes()[2] == b':' {
            path = path.trim_start_matches('/').to_string();
        }
        return percent_decode(&path);
    }
    folder_uri.to_string()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(n) = u8::from_str_radix(hex, 16) {
                out.push(n);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn last_segment(p: &str) -> String {
    if p.is_empty() {
        return String::new();
    }
    let cleaned = p.trim_end_matches(['\\', '/']);
    cleaned
        .rsplit(['\\', '/'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(cleaned)
        .to_string()
}

pub fn list_workspaces(edition: &Edition, override_dir: &str) -> Vec<Workspace> {
    let dir = resolve_client_dir(edition, override_dir);
    let ws_dir = workspace_storage_dir(&dir);
    if !ws_dir.exists() {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&ws_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            let ws_json = entry.path().join("workspace.json");
            if let Ok(text) = fs::read_to_string(&ws_json) {
                if let Ok(json) = serde_json::from_str::<Value>(&text) {
                    let folder = decode_workspace_path(json.get("folder").and_then(|v| v.as_str()).unwrap_or(""));
                    let name = if !folder.is_empty() {
                        last_segment(&folder)
                    } else {
                        json.get("workspace")
                            .and_then(|w| w.get("name"))
                            .and_then(|n| n.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("未命名-{}", id.chars().take(8).collect::<String>()))
                    };
                    out.push(Workspace {
                        id,
                        name,
                        path: folder,
                        chat_count: 0,
                    });
                }
            }
        }
    }
    // 聊天记录数量
    let db = global_storage_db(&dir);
    if db.exists() {
        if let Ok(conn) = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
            for ws in &mut out {
                let key = format!("lingma.chat.localHistory.{}", ws.id);
                if let Ok(text) = conn.query_row(
                    "SELECT value FROM ItemTable WHERE key = ?",
                    [&key],
                    |r| r.get::<_, String>(0),
                ) {
                    if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&text) {
                        ws.chat_count = arr.len();
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| b.chat_count.cmp(&a.chat_count).then(a.name.cmp(&b.name)));
    out
}

pub fn get_chat_history(edition: &Edition, workspace_id: &str, override_dir: &str) -> Result<Vec<ChatItem>, String> {
    let dir = resolve_client_dir(edition, override_dir);
    let db = global_storage_db(&dir);
    if !db.exists() {
        return Ok(Vec::new());
    }
    let conn = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开数据库失败: {}", e))?;
    let key = format!("lingma.chat.localHistory.{}", workspace_id);
    let text: String = match conn.query_row(
        "SELECT value FROM ItemTable WHERE key = ?",
        [&key],
        |r| r.get(0),
    ) {
        Ok(t) => t,
        Err(_) => return Ok(Vec::new()),
    };
    let json: Value = serde_json::from_str(&text).map_err(|e| format!("解析聊天历史 JSON 失败: {}", e))?;
    let arr = json.as_array().cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .map(|h| ChatItem {
            id: h.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            title: h.get("title").and_then(|v| v.as_str()).unwrap_or("未命名对话").to_string(),
            timestamp: h.get("timestamp").and_then(|v| v.as_i64()),
            session_id: h.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            contexts: h
                .get("context")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|c| {
                    json!({
                        "id": c.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                        "name": c.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        "type": c.get("type").and_then(|v| v.as_str()).unwrap_or("")
                    })
                })
                .collect(),
        })
        .collect())
}

/// 导出聊天历史为 JSON + Markdown
pub fn export_chat_history(
    edition: &Edition,
    workspace_id: &str,
    override_dir: &str,
) -> Result<(String, String, usize), String> {
    let chats = get_chat_history(edition, workspace_id, override_dir)?;
    let export_dir = crate::paths::data_dir().join("exports");
    let _ = fs::create_dir_all(&export_dir);
    let stamp = iso_from_ms_local(crate::crypto::now_ms()).replace([':', ' '], "-");
    let json_path = export_dir.join(format!("qoder-chats-{}-{}.json", workspace_id, stamp));
    fs::write(&json_path, serde_json::to_string_pretty(&chats).unwrap_or_default()).map_err(|e| e.to_string())?;
    let md_path = export_dir.join(format!("qoder-chats-{}-{}.md", workspace_id, stamp));
    let mut lines = vec![format!("# Qoder 会话导出（工作区 {}）", workspace_id), String::new()];
    for chat in &chats {
        let when = chat
            .timestamp
            .map(|ts| iso_from_ms_local(ts))
            .unwrap_or_else(|| "未知时间".into());
        lines.push(format!("## {}", chat.title));
        lines.push(String::new());
        lines.push(format!("- 时间：{}", when));
        lines.push(format!("- 会话 ID：{}", if chat.session_id.is_empty() { "—".into() } else { chat.session_id.clone() }));
        lines.push(String::new());
        if !chat.contexts.is_empty() {
            lines.push("上下文：".into());
            for c in &chat.contexts {
                lines.push(format!(
                    "- {}（{}）",
                    c.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    c.get("type").and_then(|v| v.as_str()).unwrap_or("unknown")
                ));
            }
            lines.push(String::new());
        }
    }
    fs::write(&md_path, lines.join("\n")).map_err(|e| e.to_string())?;
    Ok((
        json_path.to_string_lossy().to_string(),
        md_path.to_string_lossy().to_string(),
        chats.len(),
    ))
}

fn iso_from_ms_local(ms: i64) -> String {
    let secs = ms / 1000;
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days);
    let rem = secs % 86400;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[allow(dead_code)]
fn workspace_path(dir: &Path) -> String {
    dir.to_string_lossy().to_string()
}

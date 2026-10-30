//! Qoder 双后端聊天：
//!  - legacy：IDE 登录态走 Cosy 签名的 SSE 流式接口
//!  - cloud：PAT 走 Cloud Agents API
//!
//! 统一产出归一化事件：content / reasoning / tool_calls / usage / done / error。

use async_stream::stream;
use futures_util::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::account::Account;
use crate::cosy::{build_legacy_stream_headers, legacy_decode, legacy_encode};
use crate::crypto::uuid;
use crate::editions::Edition;

#[derive(Debug, Clone)]
pub enum ChatEvent {
    Content(String),
    Reasoning(String),
    ToolCalls(Value),
    Usage(TokenUsage),
    Done,
    Error(String),
}

#[derive(Debug, Clone, Default)]
pub struct TokenUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub reasoning_tokens: i64,
    pub cached_tokens: i64,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub account: Account,
    pub model: String,
    pub messages: Vec<Value>,
    pub tools: Option<Value>,
    pub reasoning_effort: Option<String>,
    pub thinking_type: Option<String>,
    pub thinking_budget: Option<i64>,
    pub image_urls: Vec<String>,
    pub workspace_root: String,
    pub timeout_ms: u64,
}

pub fn normalize_model_key(model: &str) -> String {
    match model.trim().to_lowercase().as_str() {
        "" | "auto" | "default" => "auto".into(),
        "lite" => "lite".into(),
        "claude-sonnet-4.5" | "claude_sonnet_4_5" | "sonnet" | "claude" => "auto".into(),
        other => other.to_string(),
    }
}

fn normalize_content(content: &Value) -> String {
    match content {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(arr) => {
            let mut parts = Vec::new();
            for item in arr {
                if let Some(obj) = item.as_object() {
                    if obj.get("type").and_then(|v| v.as_str()) == Some("text") {
                        parts.push(obj.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string());
                    } else if obj.get("type").and_then(|v| v.as_str()) == Some("image_url") {
                        if let Some(url) = obj.get("image_url") {
                            let u = url.as_str().map(|s| s.to_string())
                                .or_else(|| url.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()))
                                .unwrap_or_default();
                            if !u.is_empty() {
                                parts.push(format!("[image] {}", u));
                            }
                        }
                    }
                }
            }
            parts.join("\n")
        }
        other => other.to_string(),
    }
}

fn latest_prompt(messages: &[Value]) -> String {
    for m in messages.iter().rev() {
        if m.get("role").and_then(|v| v.as_str()).unwrap_or("user") != "user" {
            continue;
        }
        let text = normalize_content(m.get("content").unwrap_or(&Value::Null));
        if !text.trim().is_empty() {
            return text;
        }
    }
    String::new()
}

fn reasoning_enabled(req: &ChatRequest) -> bool {
    req.reasoning_effort
        .as_ref()
        .map(|e| !e.trim().is_empty())
        .unwrap_or(false)
        || req.thinking_type.as_deref() == Some("enabled")
        || req.thinking_type.as_deref() == Some("adaptive")
}

fn normalize_reasoning_effort(raw: Option<&str>) -> String {
    match raw.unwrap_or("").trim().to_lowercase().as_str() {
        "low" => "low",
        "medium" => "medium",
        "high" => "high",
        "xhigh" => "max",
        _ => "",
    }
    .into()
}

fn budget_to_effort(budget: Option<i64>) -> &'static str {
    match budget {
        Some(b) if b <= 0 => "medium",
        Some(b) if b <= 4000 => "low",
        Some(b) if b <= 12000 => "medium",
        Some(b) if b <= 24000 => "high",
        _ => "max",
    }
}

fn max_tokens_for_effort(effort: &str) -> i64 {
    match effort {
        "low" => 8192,
        "medium" => 16384,
        "high" => 24576,
        _ => 32768,
    }
}

/* ---------------- legacy 后端 ---------------- */

fn default_tools() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "Read",
                "description": "Read a local file or image attachment referenced in the conversation.",
                "parameters": {
                    "type": "object",
                    "properties": { "file_path": { "type": "string", "description": "Path of the file to read." } },
                    "required": ["file_path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "Bash",
                "description": "Execute a shell command when the client allows command execution.",
                "parameters": {
                    "type": "object",
                    "properties": { "command": { "type": "string", "description": "The command to execute." } },
                    "required": ["command"]
                }
            }
        }
    ])
}

fn legacy_user_contents(content: &Value) -> Vec<Value> {
    match content {
        Value::String(s) => {
            if s.trim().is_empty() {
                Vec::new()
            } else {
                vec![json!({ "type": "text", "text": s })]
            }
        }
        Value::Array(arr) => {
            let mut out = Vec::new();
            for part in arr {
                let Some(obj) = part.as_object() else { continue };
                match obj.get("type").and_then(|v| v.as_str()) {
                    Some("text") => {
                        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                            if !text.trim().is_empty() {
                                out.push(json!({ "type": "text", "text": text }));
                            }
                        }
                    }
                    Some("image_url") => {
                        if let Some(url) = obj.get("image_url") {
                            let u = url.as_str().map(|s| s.to_string())
                                .or_else(|| url.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()))
                                .unwrap_or_default();
                            if !u.is_empty() {
                                out.push(json!({ "type": "image_url", "image_url": { "url": u } }));
                            }
                        }
                    }
                    _ => {}
                }
            }
            if !out.is_empty() {
                return out;
            }
            let text = normalize_content(content);
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![json!({ "type": "text", "text": text })]
            }
        }
        other => {
            let text = normalize_content(other);
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![json!({ "type": "text", "text": text })]
            }
        }
    }
}

fn legacy_messages(messages: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("user")
            .trim()
            .to_string();
        let role = if role.is_empty() { "user".into() } else { role };
        if role == "user" {
            let contents = legacy_user_contents(message.get("content").unwrap_or(&Value::Null));
            if contents.is_empty() {
                continue;
            }
            out.push(json!({
                "role": "user",
                "content": "",
                "contents": contents,
                "response_meta": { "id": "", "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 } },
                "reasoning_content_signature": ""
            }));
        } else if role == "assistant" {
            let content = normalize_content(message.get("content").unwrap_or(&Value::Null));
            let tool_calls = message.get("tool_calls").cloned();
            let has_tool_calls = tool_calls
                .as_ref()
                .map(|t| t.as_array().map(|a| !a.is_empty()).unwrap_or(false))
                .unwrap_or(false);
            if content.trim().is_empty() && !has_tool_calls {
                continue;
            }
            let mut entry = json!({ "role": "assistant", "content": content });
            if has_tool_calls {
                entry["tool_calls"] = tool_calls.unwrap();
            }
            out.push(entry);
        } else if role == "tool" {
            let text = normalize_content(message.get("content").unwrap_or(&Value::Null));
            if text.trim().is_empty() {
                continue;
            }
            out.push(json!({
                "role": "tool",
                "tool_call_id": message.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or(""),
                "content": text
            }));
        } else {
            let text = normalize_content(message.get("content").unwrap_or(&Value::Null));
            if text.trim().is_empty() {
                continue;
            }
            out.push(json!({ "role": role, "content": text }));
        }
    }
    out
}

fn build_legacy_request(req: &ChatRequest) -> Value {
    let request_id = uuid();
    let model_key = normalize_model_key(&req.model);
    let is_reasoning = reasoning_enabled(req);
    let is_vl = !req.image_urls.is_empty();
    let prompt = latest_prompt(&req.messages);

    let mut effort = normalize_reasoning_effort(req.reasoning_effort.as_deref());
    if effort.is_empty() && is_reasoning {
        effort = budget_to_effort(req.thinking_budget).into();
    }
    let mut max_tokens = 32768i64;
    if !effort.is_empty() {
        max_tokens = max_tokens.max(max_tokens_for_effort(&effort));
    }

    let tools = match &req.tools {
        Some(t) if !t.is_null() => t.clone(),
        _ => {
            if is_vl {
                default_tools()
            } else {
                json!([])
            }
        }
    };

    let mut body = json!({
        "request_id": request_id,
        // 注意：不要携带 request_set_id —— 国内版网关实测会挂起不返回
        "chat_record_id": request_id,
        "stream": true,
        "chat_task": "FREE_INPUT",
        "chat_context": {
            "chatPrompt": "",
            "extra": {
                "context": [],
                "modelConfig": { "is_reasoning": is_reasoning, "key": model_key, "is_vl": is_vl },
                "originalContent": { "type": "text", "text": prompt }
            },
            "features": [],
            "imageUrls": Value::Null,
            "text": { "type": "text", "text": prompt }
        },
        "image_urls": Value::Null,
        "is_reply": true,
        "is_retry": false,
        "session_id": uuid(),
        "code_language": "",
        "source": 1,
        "version": "3",
        "chat_prompt": "",
        "parameters": { "max_tokens": max_tokens },
        "aliyun_user_type": req.account.user_type,
        "session_type": "qodercli",
        "agent_id": "agent_common",
        "task_id": "common",
        "model_config": {
            "key": model_key,
            "display_name": "Auto",
            "model": "",
            "format": "openai",
            "is_vl": is_vl,
            "is_reasoning": is_reasoning,
            "api_key": "",
            "url": "",
            "source": "system",
            "max_input_tokens": 180000
        },
        "business": {
            "id": uuid(),
            "begin_at": crate::crypto::now_ms(),
            "scene": "chat",
            "type": "chat",
            "sub_type": "free_input",
            "name": prompt.chars().take(30).collect::<String>(),
            "language": "",
            "parent_type": ""
        },
        "messages": legacy_messages(&req.messages),
        "tools": tools
    });
    if is_vl {
        body["chat_context"]["imageUrls"] = json!(req.image_urls);
        body["image_urls"] = json!(req.image_urls);
    }
    if !effort.is_empty() {
        body["parameters"]["reasoning_effort"] = json!(effort);
    }
    body
}

fn error_text(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    value
        .get("message")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("error").and_then(|v| v.as_str()))
        .or_else(|| value.get("error").and_then(|v| v.get("message")).and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string()
}

fn parse_legacy_line(data: &str) -> Vec<ChatEvent> {
    if data.is_empty() || data == "[DONE]" {
        return Vec::new();
    }
    let envelope: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let status_code = envelope
        .get("statusCodeValue")
        .or_else(|| envelope.get("statusCode"))
        .or_else(|| envelope.get("status"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let chunk = envelope
        .get("body")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .or_else(|| if v.is_object() { Some(v.clone()) } else { None })
        })
        .unwrap_or(Value::Null);
    let chunk_error = if chunk.is_null() {
        String::new()
    } else {
        error_text(chunk.get("error").unwrap_or(&Value::Null))
    };
    let code_value = envelope
        .get("code")
        .or_else(|| envelope.get("errorCode"))
        .or_else(|| chunk.get("code"))
        .or_else(|| chunk.get("errorCode"))
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0);
    if status_code >= 400 || !chunk_error.is_empty() || code_value == 112 {
        let detail = if code_value == 112 {
            "模型计划不可用或额度受限（code 112）".to_string()
        } else if !chunk_error.is_empty() {
            chunk_error
        } else if !chunk.is_null() {
            error_text(&chunk)
        } else {
            error_text(&envelope)
        };
        return vec![ChatEvent::Error(if code_value == 112 {
            detail
        } else {
            format!(
                "上游 HTTP {}: {}",
                if status_code >= 400 { status_code.to_string() } else { "?".into() },
                detail.chars().take(300).collect::<String>()
            )
        })];
    }
    if chunk.is_null() {
        return Vec::new();
    }
    let mut events = Vec::new();
    if let Some(choices) = chunk.get("choices").and_then(|v| v.as_array()) {
        for choice in choices {
            let Some(delta) = choice.get("delta") else { continue };
            if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                if !content.is_empty() {
                    events.push(ChatEvent::Content(content.to_string()));
                }
            }
            if let Some(reasoning) = delta.get("reasoning_content").and_then(|v| v.as_str()) {
                if !reasoning.is_empty() {
                    events.push(ChatEvent::Reasoning(reasoning.to_string()));
                }
            }
            if let Some(tool_calls) = delta.get("tool_calls") {
                if tool_calls.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                    events.push(ChatEvent::ToolCalls(tool_calls.clone()));
                }
            }
        }
    }
    if let Some(usage) = chunk.get("usage") {
        let usage = TokenUsage {
            prompt_tokens: usage.get("prompt_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            completion_tokens: usage.get("completion_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            total_tokens: usage.get("total_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
            reasoning_tokens: usage
                .get("completion_tokens_details")
                .and_then(|d| d.get("reasoning_tokens"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            cached_tokens: usage
                .get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
        };
        events.push(ChatEvent::Usage(usage));
    }
    events
}

fn legacy_stream(
    req: ChatRequest,
    edition: Edition,
) -> impl Stream<Item = ChatEvent> {
    stream! {
        let body = build_legacy_request(&req);
        let encoded = legacy_encode(&body.to_string());
        let headers = build_legacy_stream_headers(&req.account, &edition, &edition.legacy.stream_path, &encoded);
        // 诊断开关：QODER_DEBUG_DUMP=<路径> 时把实际发送的头与体转储到文件
        if let Ok(dump_path) = std::env::var("QODER_DEBUG_DUMP") {
            if !dump_path.is_empty() {
                let dump = format!(
                    "=== HEADERS ===\n{}\n=== BODY ===\n{}",
                    headers
                        .iter()
                        .map(|(k, v)| format!("{}: {}", k, v))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    encoded
                );
                let _ = std::fs::write(&dump_path, dump);
            }
        }
        // 与 Node 版请求完全对齐：HTTP/1.1、accept 头、无多余自定义头
        let client = match reqwest::Client::builder()
            .http1_only()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                yield ChatEvent::Error(format!("HTTP 客户端初始化失败: {}", e));
                return;
            }
        };
        let mut request = client
            .post(&edition.legacy.stream_url)
            // 注意：content-type 已包含在 cosy 头里，这里重复设置会发两次导致上游 500
            .header("accept", "text/event-stream")
            .header("accept-encoding", "identity")
            .body(encoded);
        for (k, v) in &headers {
            request = request.header(k.as_str(), v.as_str());
        }
        let timeout = if req.timeout_ms > 0 { req.timeout_ms } else { 300_000 };
        let resp = match tokio::time::timeout(std::time::Duration::from_millis(timeout), request.send()).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                yield ChatEvent::Error(format!("请求失败: {}", e));
                return;
            }
            Err(_) => {
                yield ChatEvent::Error("请求超时".into());
                return;
            }
        };
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            yield ChatEvent::Error(format!("HTTP {}: {}", status, text.chars().take(500).collect::<String>()));
            return;
        }
        let mut buffer = String::new();
        let mut stream = resp.bytes_stream();
        let mut saw_done = false;
        let mut saw_output = false;
        use futures_util::StreamExt;
        loop {
            let chunk = match tokio::time::timeout(std::time::Duration::from_millis(timeout), stream.next()).await {
                Ok(Some(Ok(c))) => c,
                Ok(Some(Err(e))) => {
                    yield ChatEvent::Error(format!("读取流失败: {}", e));
                    return;
                }
                Ok(None) => break,
                Err(_) => {
                    yield ChatEvent::Error("读取流超时".into());
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buffer.find('\n') {
                let line = buffer[..idx].trim().to_string();
                buffer = buffer[idx + 1..].to_string();
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        saw_done = true;
                        break;
                    }
                    for event in parse_legacy_line(data) {
                        if matches!(event, ChatEvent::Content(_) | ChatEvent::Reasoning(_) | ChatEvent::ToolCalls(_)) {
                            saw_output = true;
                        }
                        yield event;
                    }
                }
            }
            if saw_done {
                break;
            }
        }
        // 旧版 Qoder SSE 正常结束时可能没有 [DONE]，EOF 即完成；全空流不能伪装成功
        let _ = saw_done;
        if !saw_output {
            yield ChatEvent::Error("上游未返回任何内容（可能被风控、模型不可用或计划受限）".into());
            return;
        }
        yield ChatEvent::Done;
    }
}

/* ---------------- cloud 后端 ---------------- */

struct CloudSession {
    base_url: String,
    pat: String,
    default_model: String,
    workspace_root: String,
    environment_id: String,
    agent_id: String,
}

impl CloudSession {
    fn new(edition: &Edition, pat: &str, default_model: &str, workspace_root: &str) -> Self {
        CloudSession {
            base_url: format!("{}/api/v1/cloud", edition.cloud.base_url.trim_end_matches('/')),
            pat: pat.to_string(),
            default_model: default_model.to_string(),
            workspace_root: workspace_root.to_string(),
            environment_id: String::new(),
            agent_id: String::new(),
        }
    }

    async fn get_json(&self, path: &str) -> Result<Value, String> {
        let resp = crate::http::client()
            .get(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", self.pat))
            .send()
            .await
            .map_err(|e| format!("GET {} 失败: {}", path, e))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("GET {} HTTP {}: {}", path, status.as_u16(), text.chars().take(300).collect::<String>()));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    async fn post_json(&self, path: &str, body: &Value) -> Result<Option<Value>, String> {
        let resp = crate::http::client()
            .post(format!("{}{}", self.base_url, path))
            .header("Authorization", format!("Bearer {}", self.pat))
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|e| format!("POST {} 失败: {}", path, e))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("POST {} HTTP {}: {}", path, status.as_u16(), text.chars().take(300).collect::<String>()));
        }
        if text.trim().is_empty() {
            return Ok(None);
        }
        serde_json::from_str(&text).map(Some).map_err(|e| e.to_string())
    }

    async fn ensure_environment(&mut self) -> Result<(), String> {
        if !self.environment_id.is_empty() {
            return Ok(());
        }
        let list = self.get_json("/environments").await?;
        if let Some(data) = list.get("data").and_then(|v| v.as_array()) {
            for env in data {
                let status = env.get("status").and_then(|v| v.as_str()).unwrap_or("");
                if status.is_empty() || status == "ready" {
                    self.environment_id = env.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    return Ok(());
                }
            }
        }
        let created = self
            .post_json(
                "/environments",
                &json!({
                    "name": "qoder-switch2api-default",
                    "config": { "type": "cloud", "networking": { "type": "unrestricted" } }
                }),
            )
            .await?
            .ok_or_else(|| "创建环境响应为空".to_string())?;
        self.environment_id = created.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if self.environment_id.is_empty() {
            return Err("创建 Cloud 环境失败：响应缺少 id".into());
        }
        Ok(())
    }

    async fn ensure_agent(&mut self, model: &str) -> Result<(), String> {
        if !self.agent_id.is_empty() {
            return Ok(());
        }
        let instructions = "You are an efficient programming assistant.\nReply concisely and correctly.\nWhen the user supplies chat history, treat the provided transcript as authoritative context.\nIf the task is coding-related, prefer concrete patches, commands, and implementation details.";
        let created = self
            .post_json(
                "/agents",
                &json!({
                    "name": "qoder-switch2api-bridge",
                    "model": if model.trim().is_empty() { &self.default_model } else { model },
                    "system": instructions,
                    "tools": [{ "type": "bash_20250124" }, { "type": "text_editor_20250124" }]
                }),
            )
            .await?
            .ok_or_else(|| "创建 Agent 响应为空".to_string())?;
        self.agent_id = created.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if self.agent_id.is_empty() {
            return Err("创建 Cloud Agent 失败：响应缺少 id".into());
        }
        Ok(())
    }

    async fn create_session(&self) -> Result<String, String> {
        let mut body = json!({ "agent": self.agent_id, "environment_id": self.environment_id });
        if !self.workspace_root.is_empty() {
            body["metadata"] = json!({ "workspace_root": self.workspace_root });
        }
        let created = self.post_json("/sessions", &body).await?.ok_or_else(|| "创建 Session 响应为空".to_string())?;
        Ok(created.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string())
    }

    async fn send_message(&self, session_id: &str, req: &ChatRequest) -> Result<(), String> {
        self.post_json(
            &format!("/sessions/{}/events", session_id),
            &json!({ "events": [{ "type": "user.message", "content": render_prompt(req) }] }),
        )
        .await?;
        Ok(())
    }
}

fn render_prompt(req: &ChatRequest) -> String {
    let mut lines = vec![
        "You are handling an OpenAI-style chat completion request.".to_string(),
        "Conversation transcript:".to_string(),
    ];
    for msg in &req.messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        lines.push(String::new());
        lines.push(format!("[{}]", role));
        lines.push(normalize_content(msg.get("content").unwrap_or(&Value::Null)));
    }
    if let Some(tools) = &req.tools {
        if !tools.is_null() {
            lines.push("Available tool schema from the caller:".into());
            lines.push(tools.to_string());
            lines.push("If tool use is necessary, emit structured tool-use actions when supported by the runtime.".into());
        }
    }
    lines.push("Respond to the latest user request using the transcript above.".into());
    lines.join("\n")
}

fn normalize_cloud_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|item| {
                item.as_object()
                    .filter(|o| o.get("type").and_then(|v| v.as_str()) == Some("text"))
                    .and_then(|o| o.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

fn cloud_stream(req: ChatRequest, edition: Edition) -> impl Stream<Item = ChatEvent> {
    stream! {
        let mut session = CloudSession::new(
            &edition,
            &req.account.pat,
            if req.model.trim().is_empty() { "auto" } else { &req.model },
            &req.workspace_root,
        );
        if let Err(e) = session.ensure_environment().await {
            yield ChatEvent::Error(e);
            return;
        }
        if let Err(e) = session.ensure_agent(&req.model).await {
            yield ChatEvent::Error(e);
            return;
        }
        let session_id = match session.create_session().await {
            Ok(id) => id,
            Err(e) => {
                yield ChatEvent::Error(e);
                return;
            }
        };
        if session_id.is_empty() {
            yield ChatEvent::Error("创建 Cloud Session 失败".into());
            return;
        }
        if let Err(e) = session.send_message(&session_id, &req).await {
            yield ChatEvent::Error(e);
            return;
        }

        let url = format!("{}/sessions/{}/events/stream", session.base_url, session_id);
        let client = crate::http::stream_client();
        let resp = match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", session.pat))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                yield ChatEvent::Error(format!("打开流失败: {}", e));
                return;
            }
        };
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            yield ChatEvent::Error(format!("HTTP {}: {}", status, text.chars().take(500).collect::<String>()));
            return;
        }

        let mut buffer = String::new();
        let mut event_type = String::new();
        let mut data_line = String::new();
        let mut saw_output = false;
        let mut stream = resp.bytes_stream();
        let read_timeout = std::time::Duration::from_millis(if req.timeout_ms > 0 { req.timeout_ms } else { 300_000 });
        use futures_util::StreamExt;
        loop {
            let chunk = match tokio::time::timeout(read_timeout, stream.next()).await {
                Ok(Some(Ok(c))) => c,
                Ok(Some(Err(e))) => {
                    yield ChatEvent::Error(format!("读取流失败: {}", e));
                    return;
                }
                Ok(None) => break,
                Err(_) => {
                    yield ChatEvent::Error("读取流超时".into());
                    return;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buffer.find('\n') {
                let line = buffer[..idx].trim().to_string();
                buffer = buffer[idx + 1..].to_string();
                if let Some(t) = line.strip_prefix("event:") {
                    event_type = t.trim().to_string();
                    continue;
                }
                if let Some(d) = line.strip_prefix("data:") {
                    data_line = d.trim().to_string();
                    continue;
                }
                if line.is_empty() && (!event_type.is_empty() || !data_line.is_empty()) {
                    let payload: Value = if data_line.is_empty() || data_line == "{}" {
                        Value::Null
                    } else {
                        serde_json::from_str(&data_line).unwrap_or(Value::Null)
                    };
                    match event_type.as_str() {
                        "session.status_idle" | "terminated" => {
                            yield ChatEvent::Done;
                            return;
                        }
                        "session.error" => {
                            yield ChatEvent::Error(format!("session error: {}", data_line));
                            return;
                        }
                        "agent.message" => {
                            let text = normalize_cloud_content(payload.get("content").unwrap_or(&Value::Null));
                            if !text.is_empty() {
                                saw_output = true;
                                yield ChatEvent::Content(text);
                            }
                        }
                        "agent.tool_use" => {
                            saw_output = true;
                            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let input = payload.get("input").cloned().unwrap_or(json!({}));
                            let call_id = format!("call_{}", &uuid().replace('-', "").chars().take(12).collect::<String>());
                            yield ChatEvent::ToolCalls(json!([{
                                "id": call_id,
                                "type": "function",
                                "function": { "name": name, "arguments": input.to_string() }
                            }]));
                        }
                        _ => {}
                    }
                    event_type.clear();
                    data_line.clear();
                }
            }
        }
        if !saw_output {
            yield ChatEvent::Error("上游未返回任何内容（可能被风控或会话异常）".into());
            return;
        }
        yield ChatEvent::Done;
    }
}

/* ---------------- 统一入口 ---------------- */

pub fn stream_chat(req: ChatRequest, edition: Edition) -> impl Stream<Item = ChatEvent> {
    stream! {
        if !req.account.pat.is_empty() {
            let inner = cloud_stream(req, edition);
            futures_util::pin_mut!(inner);
            while let Some(event) = futures_util::StreamExt::next(&mut inner).await {
                yield event;
            }
        } else if !req.account.security_oauth_token.is_empty() {
            let inner = legacy_stream(req, edition);
            futures_util::pin_mut!(inner);
            while let Some(event) = futures_util::StreamExt::next(&mut inner).await {
                yield event;
            }
        } else {
            yield ChatEvent::Error("账号既没有 PAT 也没有登录 token，请重新登录或导入".into());
        }
    }
}

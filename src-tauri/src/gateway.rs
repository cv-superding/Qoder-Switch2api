//! OpenAI / Anthropic 兼容反代网关（每个档位一个实例）。

use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::chat::TokenUsage;
use crate::chat::{normalize_model_key, stream_chat, ChatEvent, ChatRequest};
use crate::info::fetch_model_list;
use crate::state::AppState;
use crate::usage::{record_usage, usage_stats, UsageRecord};

const DEFAULT_MODELS: &[(&str, &str)] = &[("auto", "Auto（默认）"), ("lite", "Lite")];

pub fn create_gateway(edition_value: &str, state: Arc<AppState>) -> Router {
    let edition_value = edition_value.to_string();
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/responses", post(responses))
        .route("/v1/messages", post(messages))
        .route("/usage-stats", get(usage_stats_handler))
        .layer(axum::middleware::from_fn_with_state(
            (state.clone(), edition_value.clone()),
            auth_middleware,
        ))
        .with_state((state, edition_value))
}

async fn auth_middleware(
    State((state, edition_value)): State<(Arc<AppState>, String)>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let config = state.proxy_config(&edition_value).await;
    if config.api_key.is_empty() {
        return next.run(req).await;
    }
    let is_messages = req.uri().path().starts_with("/v1/messages");
    let headers = req.headers();
    let header_token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_start_matches("Bearer ").trim().to_string())
        .or_else(|| {
            headers
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.to_string())
        })
        .unwrap_or_default();
    if header_token == config.api_key {
        next.run(req).await
    } else if is_messages {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "type": "error", "error": { "type": "authentication_error", "message": "API Key 无效" } })),
        )
            .into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": { "message": "API Key 无效", "type": "invalid_api_key", "code": "invalid_api_key", "status": 401 } })),
        )
            .into_response()
    }
}

async fn healthz(State((state, edition_value)): State<(Arc<AppState>, String)>) -> Json<Value> {
    let counts = state.accounts.read().await.counts();
    let accounts = if edition_value == "domestic" {
        counts["proxyDomestic"].as_i64().unwrap_or(0)
    } else {
        counts["proxyInternational"].as_i64().unwrap_or(0)
    };
    Json(json!({
        "ok": true,
        "edition": edition_value,
        "accounts": accounts,
    }))
}

async fn usage_stats_handler(State((state, edition_value)): State<(Arc<AppState>, String)>) -> Json<Value> {
    let _ = state;
    Json(serde_json::to_value(usage_stats(Some(&edition_value))).unwrap_or_default())
}

async fn list_models(State((state, edition_value)): State<(Arc<AppState>, String)>) -> Json<Value> {
    let config = state.proxy_config(&edition_value).await;
    let mut models: Vec<Value> = DEFAULT_MODELS
        .iter()
        .map(|(id, name)| {
            json!({
                "id": id,
                "object": "model",
                "created": now_secs(),
                "owned_by": "qoder",
                "display_name": name,
            })
        })
        .collect();

    // 上游模型列表（有账号时尝试）
    let (edition, account) = {
        let mut accounts = state.accounts.write().await;
        let account = accounts.pick(&edition_value, &config.account_group);
        let edition = state.effective_edition(&edition_value).await;
        (edition, account)
    };
    if let Some(account) = account {
        if let Ok(upstream) = fetch_model_list(&edition, &account).await {
            for m in upstream {
                let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if !id.is_empty() && !models.iter().any(|x| x.get("id").and_then(|v| v.as_str()) == Some(id)) {
                    models.push(json!({
                        "id": id,
                        "object": "model",
                        "created": now_secs(),
                        "owned_by": "qoder",
                        "display_name": m.get("displayName").and_then(|v| v.as_str()).unwrap_or(id),
                    }));
                }
            }
        }
    }
    for id in &config.extra_models {
        if !models.iter().any(|x| x.get("id").and_then(|v| v.as_str()) == Some(id.as_str())) {
            models.push(json!({
                "id": id,
                "object": "model",
                "created": now_secs(),
                "owned_by": "qoder",
                "display_name": id,
            }));
        }
    }
    Json(json!({ "object": "list", "data": models }))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/* ---------------- 账号选择与上游调用 ---------------- */

struct UpstreamResult {
    account_id: String,
    account_name: String,
    events: Vec<ChatEvent>,
}

/// 上游失败时保留最后尝试的账号，用于用量归因（避免「未知账号」）
struct UpstreamFailure {
    status: StatusCode,
    message: String,
    account_id: String,
    account_name: String,
}

fn account_display_name(account: &crate::account::Account) -> String {
    for value in [
        &account.name,
        &account.email,
        &account.phone,
        &account.label,
        &account.uid,
        &account.id,
    ] {
        if !value.is_empty() {
            return value.clone();
        }
    }
    "未知账号".to_string()
}

/// 带轮转和重试的上游调用
async fn run_with_account(
    state: &Arc<AppState>,
    edition_value: &str,
    model: &str,
    req_messages: &[Value],
    tools: Option<Value>,
    image_urls: Vec<String>,
    api: &str,
    reasoning_effort: Option<String>,
    thinking_type: Option<String>,
    thinking_budget: Option<i64>,
) -> Result<UpstreamResult, UpstreamFailure> {
    let max_attempts = 3;
    let mut last_error = "没有可用账号".to_string();
    let mut last_status = StatusCode::SERVICE_UNAVAILABLE;
    let mut last_account: Option<(String, String)> = None;

    for attempt in 0..max_attempts {
        let (edition, account) = {
            let mut accounts = state.accounts.write().await;
            let config = state.proxy_config(edition_value).await;
            let account = accounts.pick(edition_value, &config.account_group);
            let edition = state.effective_edition(edition_value).await;
            (edition, account)
        };
        let Some(account) = account else {
            // 首次就选不到账号：确实没有可用账号；重试时选不到：说明前面有真实上游错误，透传
            if attempt > 0 && last_error != "没有可用账号" {
                let (account_id, account_name) = last_account.clone().unwrap_or_default();
                return Err(UpstreamFailure {
                    status: last_status,
                    message: last_error,
                    account_id,
                    account_name,
                });
            }
            return Err(UpstreamFailure {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: format!(
                    "没有可用的{}账号：请先在账号管理页添加账号，或检查账号状态/冷却",
                    crate::editions::edition_of(edition_value).label
                ),
                account_id: String::new(),
                account_name: "无可用账号".into(),
            });
        };
        last_account = Some((account.id.clone(), account_display_name(&account)));

        // token 临期且有刷新令牌时先续期
        let needs_refresh = account
            .token_expire_at
            .map(|t| t < crate::crypto::now_ms() + 5 * 60 * 1000)
            .unwrap_or(false)
            && !account.refresh_token.is_empty();
        if needs_refresh {
            crate::account::try_refresh_account(&state.accounts, &account.id).await;
        }
        let account = state.accounts.read().await.get(&account.id).cloned().unwrap_or(account);

        let req = ChatRequest {
            account: account.clone(),
            model: model.to_string(),
            messages: req_messages.to_vec(),
            tools: tools.clone(),
            reasoning_effort: reasoning_effort.clone(),
            thinking_type: thinking_type.clone(),
            thinking_budget,
            image_urls: image_urls.clone(),
            workspace_root: String::new(),
            timeout_ms: 300_000,
        };

        let mut events = Vec::new();
        let mut failed: Option<String> = None;
        let mut stream = Box::pin(stream_chat(req, edition));
        while let Some(event) = stream.next().await {
            match event {
                ChatEvent::Error(e) => {
                    failed = Some(e);
                    break;
                }
                other => events.push(other),
            }
        }
        drop(stream);

        match failed {
            None => {
                state.accounts.write().await.mark_success(&account.id);
                return Ok(UpstreamResult {
                    account_id: account.id.clone(),
                    account_name: account_display_name(&account),
                    events,
                });
            }
            Some(err) => {
                let status_code = parse_status_code(&err);
                // 请求/模型本身的错误：换号也不会成功，也不能把健康账号打进冷却
                if matches!(status_code, 400 | 404 | 413 | 415 | 422) {
                    let message = format!(
                        "{}（模型 {} 拒绝了请求，已停止重试；请检查上下文长度、工具/参数兼容性或更换模型）",
                        err, model
                    );
                    return Err(UpstreamFailure {
                        status: StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_REQUEST),
                        message,
                        account_id: account.id.clone(),
                        account_name: account_display_name(&account),
                    });
                }
                {
                    let mut accounts = state.accounts.write().await;
                    accounts.mark_failure(&account.id, status_code, &err);
                }
                if status_code == 401 || status_code == 403 {
                    let refreshed = crate::account::try_refresh_account(&state.accounts, &account.id).await;
                    if refreshed && attempt == 0 {
                        let account2 = state.accounts.read().await.get(&account.id).cloned().unwrap();
                        let req = ChatRequest {
                            account: account2.clone(),
                            model: model.to_string(),
                            messages: req_messages.to_vec(),
                            tools: tools.clone(),
                            reasoning_effort: reasoning_effort.clone(),
                            thinking_type: thinking_type.clone(),
                            thinking_budget,
                            image_urls: image_urls.clone(),
                            workspace_root: String::new(),
                            timeout_ms: 300_000,
                        };
                        let mut retry_events = Vec::new();
                        let mut retry_failed = None;
                        let mut stream = Box::pin(stream_chat(req, state.effective_edition(edition_value).await));
                        while let Some(event) = stream.next().await {
                            match event {
                                ChatEvent::Error(e) => {
                                    retry_failed = Some(e);
                                    break;
                                }
                                other => retry_events.push(other),
                            }
                        }
                        drop(stream);
                        if retry_failed.is_none() {
                            state.accounts.write().await.mark_success(&account.id);
                            return Ok(UpstreamResult {
                                account_id: account.id.clone(),
                                account_name: account_display_name(&account),
                                events: retry_events,
                            });
                        }
                        last_error = retry_failed.unwrap_or_default();
                    } else {
                        last_error = err;
                    }
                } else {
                    last_error = err;
                }
                last_status = if (400..600).contains(&status_code) {
                    StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_GATEWAY)
                } else {
                    StatusCode::BAD_GATEWAY
                };
            }
        }
    }
    let (account_id, account_name) = last_account.unwrap_or_default();
    Err(UpstreamFailure {
        status: last_status,
        message: last_error,
        account_id,
        account_name,
    })
}

fn parse_status_code(err: &str) -> u16 {
    // 形如 "HTTP 401: ..." 或 "上游 HTTP 401"
    if let Some(rest) = err.split("HTTP ").nth(1) {
        let digits: String = rest.chars().take(3).collect();
        if let Ok(n) = digits.parse::<u16>() {
            return n;
        }
    }
    0
}

fn aggregate(events: &[ChatEvent]) -> (String, String, Vec<Value>, Option<TokenUsage>) {
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut usage: Option<TokenUsage> = None;
    for event in events {
        match event {
            ChatEvent::Content(t) => content.push_str(t),
            ChatEvent::Reasoning(t) => reasoning.push_str(t),
            ChatEvent::ToolCalls(tc) => tool_calls = merge_tool_calls(tool_calls, tc),
            ChatEvent::Usage(u) => usage = Some(u.clone()),
            _ => {}
        }
    }
    (content, reasoning, tool_calls, usage)
}

fn merge_tool_calls(acc: Vec<Value>, incoming: &Value) -> Vec<Value> {
    let mut list = acc;
    let items = match incoming {
        Value::Array(arr) => arr.clone(),
        other => vec![other.clone()],
    };
    for call in items {
        let index = call.get("index").and_then(|v| v.as_u64()).unwrap_or(list.len() as u64) as usize;
        while list.len() <= index {
            list.push(json!({ "index": list.len(), "id": "", "type": "function", "function": { "name": "", "arguments": "" } }));
        }
        let target = &mut list[index];
        if let Some(obj) = target.as_object_mut() {
            if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    obj.insert("id".into(), json!(id));
                }
            }
            if let Some(t) = call.get("type").and_then(|v| v.as_str()) {
                obj.insert("type".into(), json!(t));
            }
            if let Some(function) = call.get("function").and_then(|v| v.as_object()) {
                let entry = obj.entry("function").or_insert_with(|| json!({ "name": "", "arguments": "" }));
                if let Some(name) = function.get("name").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        entry["name"] = json!(name);
                    }
                }
                if let Some(args) = function.get("arguments").and_then(|v| v.as_str()) {
                    let existing = entry.get("arguments").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    entry["arguments"] = json!(format!("{}{}", existing, args));
                }
            }
        }
    }
    list
}

fn estimate_tokens(messages: &[Value]) -> i64 {
    let mut chars = 0usize;
    for m in messages {
        if let Some(content) = m.get("content") {
            chars += content.to_string().len();
        }
    }
    (chars / 4) as i64
}

/// 上游未返回 usage 时使用估算，且保证 total = prompt + completion
fn token_totals(usage: Option<&TokenUsage>, messages: &[Value], content: &str) -> (i64, i64, i64) {
    let prompt = usage.map(|u| u.prompt_tokens).unwrap_or_else(|| estimate_tokens(messages));
    let completion = usage
        .map(|u| u.completion_tokens)
        .unwrap_or_else(|| estimate_tokens(&[json!({ "role": "assistant", "content": content })]));
    let total = usage
        .map(|u| if u.total_tokens > 0 { u.total_tokens } else { prompt + completion })
        .unwrap_or(prompt + completion);
    (prompt, completion, total)
}

fn record(
    edition_value: &str,
    account_id: &str,
    account_name: &str,
    model: &str,
    usage: Option<&TokenUsage>,
    messages: &[Value],
    content: &str,
    api: &str,
    duration_ms: i64,
    success: bool,
    error: &str,
) {
    let prompt = usage.map(|u| u.prompt_tokens).unwrap_or_else(|| estimate_tokens(messages));
    let completion = usage
        .map(|u| u.completion_tokens)
        .unwrap_or_else(|| estimate_tokens(&[json!({ "role": "assistant", "content": content })]));
    record_usage(UsageRecord {
        ts: 0,
        edition: edition_value.to_string(),
        account_id: account_id.to_string(),
        account_name: account_name.to_string(),
        model: if model.is_empty() { "auto".into() } else { model.to_string() },
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: usage
            .map(|u| if u.total_tokens > 0 { u.total_tokens } else { prompt + completion })
            .unwrap_or(prompt + completion),
        duration_ms,
        success,
        error: error.to_string(),
        api: api.to_string(),
    });
}

/* ---------------- Chat Completions ---------------- */

async fn chat_completions(
    State((state, edition_value)): State<(Arc<AppState>, String)>,
    Json(body): Json<Value>,
) -> Response {
    let started = std::time::Instant::now();
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("auto").trim().to_string();
    let want_stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let messages = normalize_messages(body.get("messages"));
    let image_urls = collect_image_urls(&messages);

    let result = run_with_account(
        &state,
        &edition_value,
        &normalize_model_key(&model),
        &messages,
        body.get("tools").cloned(),
        image_urls,
        "chat",
        body.get("reasoning_effort").and_then(|v| v.as_str()).map(|v| v.to_string()),
        body.get("thinking")
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        body.get("thinking")
            .and_then(|v| v.get("budget_tokens"))
            .and_then(|v| v.as_i64()),
    )
    .await;
    let result = match result {
        Ok(r) => r,
        Err(failure) => {
            let message = failure.message;
            record(
                &edition_value,
                &failure.account_id,
                &failure.account_name,
                &model,
                None,
                &messages,
                "",
                "chat",
                started.elapsed().as_millis() as i64,
                false,
                &message,
            );
            return (failure.status, Json(json!({ "error": { "message": message, "type": "api_error", "code": "upstream_error" } }))).into_response();
        }
    };
    let (content, reasoning, tool_calls, usage) = aggregate(&result.events);
    let duration = started.elapsed().as_millis() as i64;
    let completion_id = format!("chatcmpl-{}", uuid_simple());
    let created = now_secs();

    if !want_stream {
        record(
            &edition_value,
            &result.account_id,
            &result.account_name,
            &model,
            usage.as_ref(),
            &messages,
            &content,
            "chat",
            duration,
            true,
            "",
        );
        let mut message = json!({
            "role": "assistant",
            "content": if content.is_empty() { Value::Null } else { json!(content) }
        });
        if !reasoning.is_empty() {
            message["reasoning_content"] = json!(reasoning);
        }
        if !tool_calls.is_empty() {
            message["tool_calls"] = json!(tool_calls);
        }
        let (prompt_tokens, completion_tokens, total_tokens) = token_totals(usage.as_ref(), &messages, &content);
        return Json(json!({
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": if tool_calls.is_empty() { "stop" } else { "tool_calls" }
            }],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens
            }
        }))
        .into_response();
    }

    // 流式：通过 mpsc 推送
    let (tx, rx) = mpsc::channel::<Result<String, std::io::Error>>(64);
    let edition_value_clone = edition_value.clone();
    let account_id = result.account_id.clone();
    let account_name = result.account_name.clone();
    let model_clone = model.clone();
    tokio::spawn(async move {
        let mut tx = tx;
        macro_rules! send {
            ($obj:expr) => {
                let _ = tx.send(Ok(format!("data: {}\n\n", $obj.to_string()))).await;
            };
        }
        send!(json!({
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_clone,
            "choices": [{ "index": 0, "delta": { "role": "assistant" }, "finish_reason": null }]
        }));
        let mut usage_final: Option<TokenUsage> = None;
        for event in &result.events {
            match event {
                ChatEvent::Content(t) => {
                    send!(json!({
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_clone,
                        "choices": [{ "index": 0, "delta": { "content": t }, "finish_reason": null }]
                    }));
                }
                ChatEvent::Reasoning(t) => {
                    send!(json!({
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_clone,
                        "choices": [{ "index": 0, "delta": { "reasoning_content": t }, "finish_reason": null }]
                    }));
                }
                ChatEvent::ToolCalls(tc) => {
                    send!(json!({
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_clone,
                        "choices": [{ "index": 0, "delta": { "tool_calls": tc }, "finish_reason": null }]
                    }));
                }
                ChatEvent::Usage(u) => usage_final = Some(u.clone()),
                _ => {}
            }
        }
        send!(json!({
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_clone,
            "choices": [{ "index": 0, "delta": {}, "finish_reason": if tool_calls.is_empty() { "stop" } else { "tool_calls" } }]
        }));
        let _ = tx.send(Ok("data: [DONE]\n\n".to_string())).await;
        record(
            &edition_value_clone,
            &account_id,
            &account_name,
            &model_clone,
            usage_final.as_ref(),
            &messages,
            &content,
            "chat",
            duration,
            true,
            "",
        );
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap()
}

/* ---------------- Responses（Codex CLI） ---------------- */

async fn responses(
    State((state, edition_value)): State<(Arc<AppState>, String)>,
    Json(body): Json<Value>,
) -> Response {
    let started = std::time::Instant::now();
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("auto").trim().to_string();
    let messages = responses_to_messages(&body);
    let image_urls = collect_image_urls(&messages);
    let result = run_with_account(
        &state,
        &edition_value,
        &normalize_model_key(&model),
        &messages,
        body.get("tools").cloned(),
        image_urls,
        "responses",
        None,
        None,
        None,
    )
    .await;
    let result = match result {
        Ok(r) => r,
        Err(failure) => {
            let message = failure.message;
            record(
                &edition_value,
                &failure.account_id,
                &failure.account_name,
                &model,
                None,
                &messages,
                "",
                "responses",
                started.elapsed().as_millis() as i64,
                false,
                &message,
            );
            return (failure.status, Json(json!({ "error": { "message": message, "type": "api_error", "code": "upstream_error" } }))).into_response();
        }
    };
    let (content, reasoning, tool_calls, usage) = aggregate(&result.events);
    let response_id = format!("resp-{}", uuid_simple());
    let created = now_secs();
    record(
        &edition_value,
        &result.account_id,
        &result.account_name,
        &model,
        usage.as_ref(),
        &messages,
        &content,
        "responses",
        started.elapsed().as_millis() as i64,
        true,
        "",
    );

    let mut output: Vec<Value> = Vec::new();
    if !reasoning.is_empty() {
        output.push(json!({ "type": "reasoning", "summary": [{ "type": "summary_text", "text": &reasoning }] }));
    }
    if !content.is_empty() {
        output.push(json!({ "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": &content, "annotations": [] }] }));
    }
    for tc in &tool_calls {
        output.push(json!({
            "type": "function_call",
            "id": tc.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "call_id": tc.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "name": tc.get("function").and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
            "arguments": tc.get("function").and_then(|f| f.get("arguments")).and_then(|v| v.as_str()).unwrap_or("")
        }));
    }
    let (input_tokens, output_tokens, total_tokens) = token_totals(usage.as_ref(), &messages, &content);

    if body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false) {
        let usage_json = json!({
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens
        });
        let mut sse = String::new();
        sse.push_str(&format!(
            "event: response.created\ndata: {}\n\n",
            json!({ "type": "response.created", "response": { "id": &response_id, "status": "in_progress", "model": &model } })
        ));
        if !content.is_empty() {
            sse.push_str(&format!(
                "event: response.output_text.delta\ndata: {}\n\n",
                json!({ "type": "response.output_text.delta", "item_id": &response_id, "output_index": 0, "content_index": 0, "delta": &content })
            ));
        }
        sse.push_str(&format!(
            "event: response.completed\ndata: {}\n\n",
            json!({ "type": "response.completed", "response": { "id": &response_id, "status": "completed", "model": &model, "output": output, "usage": usage_json } })
        ));
        sse.push_str("data: [DONE]\n\n");
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache")
            .header("X-Accel-Buffering", "no")
            .body(Body::from(sse))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    Json(json!({
        "id": response_id,
        "object": "response",
        "created_at": created,
        "status": "completed",
        "model": model,
        "output": output,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens
        }
    }))
    .into_response()
}

/* ---------------- Messages（Anthropic） ---------------- */

async fn messages(
    State((state, edition_value)): State<(Arc<AppState>, String)>,
    Json(body): Json<Value>,
) -> Response {
    let started = std::time::Instant::now();
    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("auto").trim().to_string();
    let messages = anthropic_to_messages(&body);
    let image_urls = collect_image_urls(&messages);
    let result = run_with_account(
        &state,
        &edition_value,
        &normalize_model_key(&model),
        &messages,
        body.get("tools").cloned(),
        image_urls,
        "messages",
        None,
        None,
        None,
    )
    .await;
    let result = match result {
        Ok(r) => r,
        Err(failure) => {
            let message = failure.message;
            record(
                &edition_value,
                &failure.account_id,
                &failure.account_name,
                &model,
                None,
                &messages,
                "",
                "messages",
                started.elapsed().as_millis() as i64,
                false,
                &message,
            );
            return (failure.status, Json(json!({ "type": "error", "error": { "type": "api_error", "message": message } }))).into_response();
        }
    };
    let (content, reasoning, tool_calls, usage) = aggregate(&result.events);
    let msg_id = format!("msg-{}", uuid_simple());
    record(
        &edition_value,
        &result.account_id,
        &result.account_name,
        &model,
        usage.as_ref(),
        &messages,
        &content,
        "messages",
        started.elapsed().as_millis() as i64,
        true,
        "",
    );

    let mut content_blocks: Vec<Value> = Vec::new();
    if !reasoning.is_empty() {
        content_blocks.push(json!({ "type": "thinking", "thinking": &reasoning }));
    }
    if !content.is_empty() {
        content_blocks.push(json!({ "type": "text", "text": &content }));
    }
    for tc in &tool_calls {
        content_blocks.push(json!({
            "type": "tool_use",
            "id": tc.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "name": tc.get("function").and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
            "input": safe_json(tc.get("function").and_then(|f| f.get("arguments")).and_then(|v| v.as_str()).unwrap_or("{}"))
        }));
    }
    if content_blocks.is_empty() {
        content_blocks.push(json!({ "type": "text", "text": "" }));
    }
    let (input_tokens, output_tokens, _) = token_totals(usage.as_ref(), &messages, &content);
    let stop_reason = if tool_calls.is_empty() { "end_turn" } else { "tool_use" };

    if body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false) {
        let mut sse = String::new();
        sse.push_str(&format!(
            "event: message_start\ndata: {}\n\n",
            json!({
                "type": "message_start",
                "message": { "id": &msg_id, "type": "message", "role": "assistant", "model": &model, "content": [], "usage": { "input_tokens": input_tokens, "output_tokens": 0 } }
            })
        ));
        for (index, block) in content_blocks.iter().enumerate() {
            sse.push_str(&format!(
                "event: content_block_start\ndata: {}\n\n",
                json!({ "type": "content_block_start", "index": index, "content_block": block })
            ));
            let delta = match block.get("type").and_then(|v| v.as_str()) {
                Some("text") => json!({ "type": "text_delta", "text": block.get("text").cloned().unwrap_or(json!("")) }),
                Some("thinking") => json!({ "type": "thinking_delta", "thinking": block.get("thinking").cloned().unwrap_or(json!("")) }),
                _ => json!({ "type": "input_json_delta", "partial_json": block.get("input").map(|v| v.to_string()).unwrap_or_default() }),
            };
            sse.push_str(&format!(
                "event: content_block_delta\ndata: {}\n\n",
                json!({ "type": "content_block_delta", "index": index, "delta": delta })
            ));
            sse.push_str(&format!(
                "event: content_block_stop\ndata: {}\n\n",
                json!({ "type": "content_block_stop", "index": index })
            ));
        }
        sse.push_str(&format!(
            "event: message_delta\ndata: {}\n\n",
            json!({ "type": "message_delta", "delta": { "stop_reason": stop_reason }, "usage": { "output_tokens": output_tokens } })
        ));
        sse.push_str(&format!("event: message_stop\ndata: {}\n\n", json!({ "type": "message_stop" })));
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache")
            .header("X-Accel-Buffering", "no")
            .body(Body::from(sse))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    Json(json!({
        "id": msg_id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content_blocks,
        "stop_reason": stop_reason,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens
        }
    }))
    .into_response()
}

/* ---------------- 格式转换 ---------------- */

fn normalize_messages(messages: Option<&Value>) -> Vec<Value> {
    messages
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|m| {
                    json!({
                        "role": m.get("role").and_then(|v| v.as_str()).unwrap_or("user"),
                        "content": m.get("content").cloned().unwrap_or(json!("")),
                        "tool_calls": m.get("tool_calls").cloned(),
                        "tool_call_id": m.get("tool_call_id").cloned()
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn collect_image_urls(messages: &[Value]) -> Vec<String> {
    let mut urls = Vec::new();
    for m in messages {
        if let Some(arr) = m.get("content").and_then(|v| v.as_array()) {
            for part in arr {
                if part.get("type").and_then(|v| v.as_str()) == Some("image_url") {
                    if let Some(url) = part.get("image_url") {
                        let u = url
                            .as_str()
                            .map(|s| s.to_string())
                            .or_else(|| url.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()))
                            .unwrap_or_default();
                        if !u.is_empty() {
                            urls.push(u);
                        }
                    }
                }
            }
        }
    }
    urls
}

fn extract_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|c| {
                let t = c.get("type").and_then(|v| v.as_str());
                if t == Some("text") || t == Some("output_text") {
                    c.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn responses_to_messages(body: &Value) -> Vec<Value> {
    let mut messages = Vec::new();
    if let Some(instructions) = body.get("instructions").and_then(|v| v.as_str()) {
        if !instructions.is_empty() {
            messages.push(json!({ "role": "system", "content": instructions }));
        }
    }
    match body.get("input") {
        Some(Value::String(s)) => messages.push(json!({ "role": "user", "content": s })),
        Some(Value::Array(arr)) => {
            for item in arr {
                let Some(obj) = item.as_object() else { continue };
                if let Some(role) = obj.get("role").and_then(|v| v.as_str()) {
                    let content = obj.get("content").cloned().unwrap_or(json!(""));
                    messages.push(json!({ "role": role, "content": content }));
                } else if obj.get("type").and_then(|v| v.as_str()) == Some("function_call_output") {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": obj.get("call_id").and_then(|v| v.as_str()).unwrap_or(""),
                        "content": obj.get("output").map(|v| v.to_string()).unwrap_or_default()
                    }));
                } else if obj.get("type").and_then(|v| v.as_str()) == Some("message") {
                    if let Some(content) = obj.get("content") {
                        messages.push(json!({
                            "role": obj.get("role").and_then(|v| v.as_str()).unwrap_or("user"),
                            "content": extract_text(content)
                        }));
                    }
                }
            }
        }
        _ => {}
    }
    if messages.is_empty() {
        messages.push(json!({ "role": "user", "content": " " }));
    }
    messages
}

fn anthropic_to_messages(body: &Value) -> Vec<Value> {
    let mut messages = Vec::new();
    if let Some(system) = body.get("system") {
        let text = extract_text(system);
        if !text.is_empty() {
            messages.push(json!({ "role": "system", "content": text }));
        }
    }
    if let Some(arr) = body.get("messages").and_then(|v| v.as_array()) {
        for m in arr {
            let role = if m.get("role").and_then(|v| v.as_str()) == Some("assistant") {
                "assistant"
            } else {
                "user"
            };
            match m.get("content") {
                Some(Value::String(s)) => messages.push(json!({ "role": role, "content": s })),
                Some(Value::Array(arr)) => {
                    let mut parts: Vec<Value> = Vec::new();
                    for block in arr {
                        let Some(obj) = block.as_object() else { continue };
                        match obj.get("type").and_then(|v| v.as_str()) {
                            Some("text") => parts.push(json!({ "type": "text", "text": obj.get("text").and_then(|v| v.as_str()).unwrap_or("") })),
                            Some("image") => {
                                let source = obj.get("source");
                                let url = source
                                    .and_then(|s| s.get("url"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .or_else(|| {
                                        source
                                            .and_then(|s| s.get("data"))
                                            .and_then(|v| v.as_str())
                                            .map(|data| {
                                                format!(
                                                    "data:{};base64,{}",
                                                    source.and_then(|s| s.get("media_type")).and_then(|v| v.as_str()).unwrap_or("image/png"),
                                                    data
                                                )
                                            })
                                    })
                                    .unwrap_or_default();
                                if !url.is_empty() {
                                    parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
                                }
                            }
                            Some("tool_use") => {
                                messages.push(json!({
                                    "role": role,
                                    "content": "",
                                    "tool_calls": [{
                                        "id": obj.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                                        "type": "function",
                                        "function": {
                                            "name": obj.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                            "arguments": obj.get("input").map(|v| v.to_string()).unwrap_or_default()
                                        }
                                    }]
                                }));
                            }
                            Some("tool_result") => {
                                let text = obj.get("content").map(|c| extract_text(c)).unwrap_or_default();
                                messages.push(json!({
                                    "role": "tool",
                                    "tool_call_id": obj.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or(""),
                                    "content": text
                                }));
                            }
                            _ => {}
                        }
                    }
                    if !parts.is_empty() {
                        if parts.len() == 1 && parts[0].get("type").and_then(|v| v.as_str()) == Some("text") {
                            messages.push(json!({ "role": role, "content": parts[0].get("text").and_then(|v| v.as_str()).unwrap_or("") }));
                        } else {
                            messages.push(json!({ "role": role, "content": parts }));
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if messages.is_empty() {
        messages.push(json!({ "role": "user", "content": " " }));
    }
    messages
}

fn safe_json(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| json!({}))
}

fn uuid_simple() -> String {
    crate::crypto::uuid().replace('-', "")
}

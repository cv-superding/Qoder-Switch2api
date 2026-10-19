//! WebUI 后端 API（/api/*），与 Node 版保持同一套路由契约。

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

use crate::account::AccountInput;
use crate::editions;
use crate::info;
use crate::oauth;
use crate::sessions;
use crate::state::{AppState, ProxyConfig, Settings};
use crate::store::{append_jsonl, load_json, read_jsonl, save_json};
use crate::switcher::{self, SwitchStep};
use crate::usage::usage_stats;

pub fn create_api_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/status", get(get_status))
        .route("/about", get(get_about))
        .route("/accounts", get(list_accounts).post(add_account))
        .route("/api-account/{id}", patch(update_account))
        .route("/accounts/{id}", delete(delete_account))
        .route("/accounts/{id}/refresh", post(refresh_account))
        .route("/accounts/{id}/credit", get(get_credit))
        .route("/accounts/import-client", post(import_client_account))
        .route("/accounts/checkin", post(checkin_accounts))
        .route("/checkin/logs", get(get_checkin_logs))
        .route("/oauth/start", post(oauth_start))
        .route("/oauth/open-url", post(open_url))
        .route("/oauth/poll/{login_id}", get(oauth_poll))
        .route("/oauth/cancel/{login_id}", post(oauth_cancel))
        .route("/accounts/{id}/switch", post(switch_account))
        .route("/switch-job/{job_id}", get(switch_job))
        .route("/client/detect", get(detect_client))
        .route("/proxy/config", get(get_proxy_config).post(save_proxy_config))
        .route("/proxy/models", get(proxy_models))
        .route("/usage", get(get_usage))
        .route("/sessions/workspaces", get(list_workspaces))
        .route("/sessions/chats", get(get_chats))
        .route("/sessions/export", post(export_chats))
        .route("/settings", get(get_settings).post(save_settings))
        .with_state(state)
}

fn ok_json(value: Value) -> Response {
    Json(value).into_response()
}

fn err(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/* ---------------- 状态 ---------------- */

async fn get_status(State(state): State<Arc<AppState>>) -> Response {
    let accounts = state.accounts.read().await;
    let counts = accounts.counts();
    let settings = state.settings.read().await;

    let mut edition_status = serde_json::Map::new();
    for value in editions::EDITION_LIST {
        let edition = editions::edition_of(value);
        let client = switcher::detect_client(&edition, &settings.client_dir_overrides.get(value).cloned().unwrap_or_default());
        let current = accounts.client_current.get(value).and_then(|c| c.clone());
        let config = settings
            .proxy
            .get(value)
            .cloned()
            .unwrap_or_else(|| ProxyConfig {
                listen: format!("127.0.0.1:{}", edition.proxy_default_port),
                ..Default::default()
            });
        let proxy_accounts = if value == "domestic" {
            counts["proxyDomestic"].as_i64().unwrap_or(0)
        } else {
            counts["proxyInternational"].as_i64().unwrap_or(0)
        };
        edition_status.insert(
            value.to_string(),
            json!({
                "client": client,
                "currentAccount": current,
                "proxy": {
                    "enabled": config.enabled,
                    "listen": config.listen,
                    "hasApiKey": !config.api_key.is_empty(),
                    "extraModels": config.extra_models,
                    "accountGroup": config.account_group,
                    "running": crate::proxy_running(value),
                },
                "accounts": counts[value].as_i64().unwrap_or(0),
                "proxyAccounts": proxy_accounts,
            }),
        );
    }

    ok_json(json!({
        "version": "1.0.0",
        "editions": edition_status,
        "counts": counts,
        "sqlite": true,
    }))
}

async fn get_about() -> Response {
    ok_json(json!({
        "name": "Qoder-Switch2api",
        "version": "1.0.0",
        "description": "Qoder（国内版 Qoder CN / 国际版）多账号切换 + OpenAI/Anthropic 兼容反代",
        "references": [
            "https://github.com/cv-superding/WorkBuddy-Switch2api（界面与架构参考）",
            "https://github.com/jyao0708/qoder2api（Qoder 协议参考）",
            "https://github.com/70548887/Qoder-Switch（MITM 切换参考）"
        ]
    }))
}

/* ---------------- 账号 ---------------- */

async fn list_accounts(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let accounts = state.accounts.read().await;
    let edition = q.get("edition").map(|s| s.as_str());
    ok_json(json!({ "accounts": accounts.list_views(edition) }))
}

async fn add_account(State(state): State<Arc<AppState>>, Json(body): Json<AccountInput>) -> Response {
    let mut accounts = state.accounts.write().await;
    match accounts.add(&body) {
        Ok(account) => ok_json(json!({ "account": accounts.view(&account) })),
        Err(e) => err(StatusCode::BAD_REQUEST, &e),
    }
}

async fn update_account(State(state): State<Arc<AppState>>, Path(id): Path<String>, Json(body): Json<Value>) -> Response {
    let mut accounts = state.accounts.write().await;
    match accounts.update(&id, &body) {
        Ok(account) => ok_json(json!({ "account": accounts.view(&account) })),
        Err(e) => err(StatusCode::BAD_REQUEST, &e),
    }
}

async fn delete_account(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let mut accounts = state.accounts.write().await;
    let ok = accounts.remove(&id);
    ok_json(json!({ "ok": ok }))
}

async fn refresh_account(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let mut accounts = state.accounts.write().await;
    let ok = accounts.try_refresh(&id).await;
    if ok {
        let account = accounts.get(&id).cloned().unwrap();
        ok_json(json!({ "ok": true, "account": accounts.view(&account) }))
    } else {
        let last_error = accounts.get(&id).map(|a| a.last_error.clone()).unwrap_or_default();
        err(StatusCode::BAD_REQUEST, &format!("{}（可能需要重新登录）", last_error))
    }
}

async fn get_credit(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let (edition_value, account) = {
        let accounts = state.accounts.read().await;
        match accounts.get(&id) {
            Some(a) => (a.edition.clone(), a.clone()),
            None => return err(StatusCode::NOT_FOUND, "账号不存在"),
        }
    };
    let edition = state.effective_edition(&edition_value).await;
    let usage = info::get_quota_usage(&edition, &account).await;
    let plan = info::get_user_plan(&edition, &account).await;
    match (usage, plan) {
        (Ok(usage), Ok(plan)) => {
            let quota_patch = usage.quota.as_ref().map(|q| {
                json!({
                    "total": q.total,
                    "used": q.used,
                    "remaining": q.remaining,
                    "percentage": q.percentage,
                    "unit": q.unit,
                    "expiresAt": usage.expires_at,
                    "updatedAt": crate::crypto::now_ms()
                })
            });
            let plan_patch = json!({
                "userType": plan.user_type,
                "planTierName": plan.plan_tier_name,
                "endDate": plan.end_date
            });
            let mut accounts = state.accounts.write().await;
            let mut patch = serde_json::Map::new();
            if let Some(q) = quota_patch {
                patch.insert("quota".into(), q);
            }
            patch.insert("plan".into(), plan_patch);
            patch.insert("lastError".into(), json!(""));
            let _ = accounts.update(&id, &Value::Object(patch));
            ok_json(json!({ "usage": usage, "plan": plan }))
        }
        (Err(e), _) | (_, Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn import_client_account(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let edition_value = body.get("edition").and_then(|v| v.as_str()).unwrap_or("domestic").to_string();
    let edition = state.effective_edition(&edition_value).await;
    let override_dir = {
        let settings = state.settings.read().await;
        settings.client_dir_overrides.get(&edition_value).cloned().unwrap_or_default()
    };
    let auth = match switcher::read_client_auth(&edition, &override_dir) {
        Ok(Some(a)) => a,
        Ok(None) => return err(StatusCode::NOT_FOUND, "未检测到本机 Qoder 客户端登录态（请先打开客户端登录）"),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let input = AccountInput {
        edition: Some(edition_value.clone()),
        label: String::new(),
        name: auth.user_name.clone(),
        email: auth.user_email.clone(),
        phone: auth.user_phone.clone(),
        avatar_url: String::new(),
        uid: auth.user_id.clone(),
        aid: String::new(),
        yx_uid: String::new(),
        org_id: String::new(),
        org_name: String::new(),
        user_type: "personal_standard".into(),
        security_oauth_token: auth.token.clone(),
        refresh_token: auth.refresh_token.clone(),
        token_expire_at: auth.expires_at.clone().map(Value::String),
        refresh_token_expires_at: auth.refresh_token_expires_at.clone().map(Value::String),
        pat: String::new(),
        machine_id: auth.machine_id.clone(),
        machine_token: String::new(),
        machine_type: String::new(),
        group: String::new(),
        auth_source: "client-import".into(),
        quota: None,
        plan: None,
        last_switch_at: None,
    };
    let mut accounts = state.accounts.write().await;
    match accounts.add(&input) {
        Ok(account) => ok_json(json!({ "account": accounts.view(&account), "source": auth.source })),
        Err(e) => err(StatusCode::BAD_REQUEST, &e),
    }
}

async fn checkin_accounts(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let ids: Option<Vec<String>> = body
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect());
    let accounts_snapshot = {
        let accounts = state.accounts.read().await;
        match &ids {
            Some(ids) => ids.iter().filter_map(|id| accounts.get(id).cloned()).collect::<Vec<_>>(),
            None => accounts.accounts.clone(),
        }
    };
    let mut results = Vec::new();
    for account in accounts_snapshot {
        let edition = state.effective_edition(&account.edition).await;
        let name = if account.name.is_empty() {
            if account.email.is_empty() { account.uid.clone() } else { account.email.clone() }
        } else {
            account.name.clone()
        };
        match info::list_campaigns(&edition, &account).await {
            Ok(campaigns) => {
                if info::today_checked_in(&campaigns) {
                    results.push(json!({ "id": account.id, "name": name, "result": "already", "rewardCredit": null }));
                    continue;
                }
                match info::find_claimable_checkin(&campaigns) {
                    Some(claimable) => {
                        let campaign_id = claimable.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        match info::claim_campaign(&edition, &account, campaign_id).await {
                            Ok(claim) => {
                                let replayed = claim.get("replayed").and_then(|v| v.as_bool()).unwrap_or(false);
                                let reward = claim
                                    .get("rewardCredit")
                                    .and_then(|v| v.as_f64())
                                    .or_else(|| claimable.get("rewardCredit").and_then(|v| v.as_f64()));
                                append_jsonl(
                                    "checkin.jsonl",
                                    &json!({
                                        "accountId": account.id,
                                        "edition": account.edition,
                                        "result": if replayed { "replayed" } else { "success" },
                                        "rewardCredit": reward
                                    }),
                                );
                                results.push(json!({
                                    "id": account.id,
                                    "name": name,
                                    "result": if replayed { "already" } else { "success" },
                                    "rewardCredit": reward
                                }));
                            }
                            Err(e) => {
                                append_jsonl(
                                    "checkin.jsonl",
                                    &json!({ "accountId": account.id, "edition": account.edition, "result": "error", "error": e }),
                                );
                                results.push(json!({ "id": account.id, "name": name, "result": "error", "error": e }));
                            }
                        }
                    }
                    None => results.push(json!({ "id": account.id, "name": name, "result": "none", "error": "暂无可领取的签到活动" })),
                }
            }
            Err(e) => {
                results.push(json!({ "id": account.id, "name": name, "result": "error", "error": e }));
            }
        }
    }
    ok_json(json!({ "accounts": results }))
}

async fn get_checkin_logs() -> Response {
    ok_json(json!({ "logs": read_jsonl("checkin.jsonl", 200) }))
}

/* ---------------- OAuth ---------------- */

/// 用系统默认浏览器打开外部链接（桌面窗口里 window.open 无效）
async fn open_url(Json(body): Json<Value>) -> Response {
    let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return err(StatusCode::BAD_REQUEST, "仅支持 http(s) 链接");
    }
    match open::that(url) {
        Ok(_) => ok_json(json!({ "ok": true })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &format!("打开浏览器失败: {}", e)),
    }
}

async fn oauth_start(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let edition_value = body.get("edition").and_then(|v| v.as_str()).unwrap_or("domestic").to_string();
    let edition = state.effective_edition(&edition_value).await;
    let client_dir = {
        let settings = state.settings.read().await;
        let override_dir = settings.client_dir_overrides.get(&edition_value).cloned().unwrap_or_default();
        if override_dir.trim().is_empty() {
            None
        } else {
            Some(std::path::PathBuf::from(override_dir))
        }
    };
    let response = oauth::start_login(&edition, client_dir.as_deref());
    ok_json(json!({
        "loginId": response.login_id,
        "verificationUri": response.verification_uri,
        "expiresIn": response.expires_in
    }))
}

async fn oauth_poll(State(state): State<Arc<AppState>>, Path(login_id): Path<String>) -> Response {
    let outcome = oauth::poll_login(&login_id).await;
    match outcome.status.as_str() {
        "done" => {
            let input = outcome.account.unwrap();
            let edition_value = input.edition.clone().unwrap_or_else(|| "domestic".into());
            let mut accounts = state.accounts.write().await;
            match accounts.add(&input) {
                Ok(account) => ok_json(json!({ "status": "done", "account": accounts.view(&account), "edition": edition_value })),
                Err(e) => ok_json(json!({ "status": "error", "error": e })),
            }
        }
        other => ok_json(json!({ "status": other, "error": outcome.error })),
    }
}

async fn oauth_cancel(Path(login_id): Path<String>) -> Response {
    oauth::cancel_login(&login_id);
    ok_json(json!({ "ok": true }))
}

/* ---------------- 客户端切换 ---------------- */

#[derive(Deserialize)]
struct SwitchBody {
    #[serde(default = "default_restart")]
    restart: bool,
}

fn default_restart() -> bool {
    true
}

async fn switch_account(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<SwitchBody>,
) -> Response {
    let (account, edition_value, override_dir, exe_override) = {
        let accounts = state.accounts.read().await;
        let settings = state.settings.read().await;
        match accounts.get(&id) {
            Some(a) => (
                a.clone(),
                a.edition.clone(),
                settings.client_dir_overrides.get(&a.edition).cloned().unwrap_or_default(),
                settings.client_exe_paths.get(&a.edition).cloned().unwrap_or_default(),
            ),
            None => return err(StatusCode::NOT_FOUND, "账号不存在"),
        }
    };
    let job_id = crate::crypto::random_id("job");
    let job_tx = crate::switch_job_sender();
    {
        let mut job = job_tx.lock().unwrap_or_else(|e| e.into_inner());
        job.insert(
            job_id.clone(),
            crate::SwitchJob {
                steps: Vec::new(),
                done: false,
                error: String::new(),
                result: None,
            },
        );
    }
    let state2 = state.clone();
    let job_id2 = job_id.clone();
    tokio::spawn(async move {
        let edition = state2.effective_edition(&edition_value).await;
        let mut job_tx2 = crate::switch_job_sender();
        let account_id = account.id.clone();
        match switcher::switch_client_account(
            &account,
            &edition,
            &override_dir,
            body.restart,
            &exe_override,
            |step: SwitchStep| {
                let mut job = job_tx2.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(j) = job.get_mut(&job_id2) {
                    j.steps.push(step);
                }
            },
        )
        .await
        {
            Ok(dir) => {
                let view = {
                    let mut accounts = state2.accounts.write().await;
                    let _ = accounts.update(
                        &account_id,
                        &json!({ "lastSwitchAt": crate::crypto::now_ms() }),
                    );
                    accounts.set_client_current(
                        &edition_value,
                        Some(crate::account::ClientCurrent {
                            uid: account.uid.clone(),
                            name: account.name.clone(),
                            email: account.email.clone(),
                            id: account.id.clone(),
                            at: 0,
                        }),
                    );
                    accounts.get(&account_id).map(|a| accounts.view(a))
                };
                let mut job = job_tx2.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(j) = job.get_mut(&job_id2) {
                    j.done = true;
                    j.result = Some(json!({ "account": view, "dir": dir }));
                }
            }
            Err(e) => {
                let mut job = job_tx2.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(j) = job.get_mut(&job_id2) {
                    j.done = true;
                    j.error = e;
                }
            }
        }
    });
    ok_json(json!({ "jobId": job_id }))
}

async fn switch_job(Path(job_id): Path<String>) -> Response {
    let job_tx = crate::switch_job_sender();
    let job = job_tx.lock().unwrap_or_else(|e| e.into_inner());
    match job.get(&job_id) {
        Some(j) => ok_json(serde_json::to_value(j).unwrap_or_default()),
        None => err(StatusCode::NOT_FOUND, "任务不存在或已结束"),
    }
}

async fn detect_client(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let edition_value = q.get("edition").cloned().unwrap_or_else(|| "domestic".into());
    let edition = state.effective_edition(&edition_value).await;
    let override_dir = {
        let settings = state.settings.read().await;
        settings.client_dir_overrides.get(&edition_value).cloned().unwrap_or_default()
    };
    let client = switcher::detect_client(&edition, &override_dir);
    ok_json(json!({ "client": client }))
}

/* ---------------- 反代配置 ---------------- */

async fn get_proxy_config(State(state): State<Arc<AppState>>) -> Response {
    let settings = state.settings.read().await;
    ok_json(json!({ "proxy": settings.proxy }))
}

async fn save_proxy_config(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let mut settings = state.settings.read().await.clone();
    if let Some(incoming) = body.get("proxy").and_then(|v| v.as_object()) {
        for (key, value) in incoming {
            let entry = settings.proxy.entry(key.clone()).or_insert_with(|| ProxyConfig {
                listen: if key == "international" { "127.0.0.1:7892".into() } else { "127.0.0.1:7891".into() },
                ..Default::default()
            });
            if let Some(v) = value.get("enabled").and_then(|v| v.as_bool()) {
                entry.enabled = v;
            }
            if let Some(v) = value.get("listen").and_then(|v| v.as_str()) {
                entry.listen = v.to_string();
            }
            if let Some(v) = value.get("apiKey").and_then(|v| v.as_str()) {
                entry.api_key = v.to_string();
            }
            if let Some(v) = value.get("extraModels").and_then(|v| v.as_array()) {
                entry.extra_models = v
                    .iter()
                    .filter_map(|m| m.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
            }
            if let Some(v) = value.get("accountGroup").and_then(|v| v.as_str()) {
                entry.account_group = v.to_string();
            }
        }
    }
    save_json("settings.json", &settings);
    *state.settings.write().await = settings.clone();
    crate::refresh_proxy_servers(&state).await;
    ok_json(json!({ "proxy": settings.proxy }))
}

async fn proxy_models(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let edition_value = q.get("edition").cloned().unwrap_or_else(|| "domestic".into());
    let edition = state.effective_edition(&edition_value).await;
    let config = state.proxy_config(&edition_value).await;
    let account = {
        let mut accounts = state.accounts.write().await;
        accounts.pick(&edition_value, &config.account_group)
    };
    let Some(account) = account else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "没有可用账号，无法拉取模型列表");
    };
    match info::fetch_model_list(&edition, &account).await {
        Ok(models) => ok_json(json!({ "models": models })),
        Err(e) => err(StatusCode::BAD_GATEWAY, &e),
    }
}

async fn get_usage(Query(q): Query<HashMap<String, String>>) -> Response {
    let edition = q.get("edition").map(|s| s.as_str());
    ok_json(serde_json::to_value(usage_stats(edition)).unwrap_or_default())
}

/* ---------------- 会话管理 ---------------- */

async fn list_workspaces(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let edition_value = q.get("edition").cloned().unwrap_or_else(|| "domestic".into());
    let edition = state.effective_edition(&edition_value).await;
    let override_dir = {
        let settings = state.settings.read().await;
        settings.client_dir_overrides.get(&edition_value).cloned().unwrap_or_default()
    };
    let list = sessions::list_workspaces(&edition, &override_dir);
    ok_json(json!({ "workspaces": list }))
}

async fn get_chats(State(state): State<Arc<AppState>>, Query(q): Query<HashMap<String, String>>) -> Response {
    let edition_value = q.get("edition").cloned().unwrap_or_else(|| "domestic".into());
    let workspace_id = q.get("workspaceId").cloned().unwrap_or_default();
    if workspace_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "缺少 workspaceId");
    }
    let edition = state.effective_edition(&edition_value).await;
    let override_dir = {
        let settings = state.settings.read().await;
        settings.client_dir_overrides.get(&edition_value).cloned().unwrap_or_default()
    };
    match sessions::get_chat_history(&edition, &workspace_id, &override_dir) {
        Ok(chats) => ok_json(json!({ "chats": chats })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn export_chats(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let edition_value = body.get("edition").and_then(|v| v.as_str()).unwrap_or("domestic").to_string();
    let workspace_id = body.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if workspace_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "缺少 workspaceId");
    }
    let edition = state.effective_edition(&edition_value).await;
    let override_dir = {
        let settings = state.settings.read().await;
        settings.client_dir_overrides.get(&edition_value).cloned().unwrap_or_default()
    };
    match sessions::export_chat_history(&edition, &workspace_id, &override_dir) {
        Ok((json_path, md_path, count)) => ok_json(json!({ "jsonPath": json_path, "mdPath": md_path, "count": count })),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/* ---------------- 设置 ---------------- */

async fn get_settings(State(state): State<Arc<AppState>>) -> Response {
    let settings = state.settings.read().await;
    ok_json(json!({ "settings": sanitize_settings(&settings) }))
}

fn sanitize_settings(settings: &Settings) -> Value {
    serde_json::to_value(settings).unwrap_or_default()
}

async fn save_settings(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    let mut settings = state.settings.read().await.clone();
    let incoming = body.get("settings").cloned().unwrap_or(json!({}));
    if let Some(theme) = incoming.get("theme").and_then(|v| v.as_str()) {
        if ["light", "dark", "system"].contains(&theme) {
            settings.theme = theme.to_string();
        }
    }
    if let Some(v) = incoming.get("clientDirOverrides").and_then(|v| v.as_object()) {
        settings.client_dir_overrides.clear();
        for (key, value) in v {
            settings
                .client_dir_overrides
                .insert(key.clone(), value.as_str().unwrap_or("").to_string());
        }
    }
    if let Some(v) = incoming.get("clientExePaths").and_then(|v| v.as_object()) {
        settings.client_exe_paths.clear();
        for (key, value) in v {
            settings
                .client_exe_paths
                .insert(key.clone(), value.as_str().unwrap_or("").to_string());
        }
    }
    if let Some(v) = incoming.get("autoCheckin").and_then(|v| v.as_object()) {
        settings.auto_checkin.enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
        settings.auto_checkin.hour = v.get("hour").and_then(|x| x.as_i64()).unwrap_or(9);
    }
    if let Some(v) = incoming.get("endpointOverrides").and_then(|v| v.as_object()) {
        settings.endpoint_overrides.clear();
        for (edition, fields) in v {
            if let Some(fields) = fields.as_object() {
                let mut clean = HashMap::new();
                for key in ["clientId", "openApiBaseUrl", "streamUrl", "modelListUrl", "cloudBaseUrl"] {
                    if let Some(value) = fields.get(key).and_then(|x| x.as_str()) {
                        if !value.trim().is_empty() {
                            clean.insert(key.to_string(), value.trim().to_string());
                        }
                    }
                }
                settings.endpoint_overrides.insert(edition.clone(), clean);
            }
        }
    }
    save_json("settings.json", &settings);
    *state.settings.write().await = settings.clone();
    crate::refresh_proxy_servers(&state).await;
    ok_json(json!({ "settings": sanitize_settings(&settings) }))
}

#[allow(dead_code)]
fn unused_load() -> Value {
    load_json::<Value>("unused.json")
}

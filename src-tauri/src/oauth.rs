//! Qoder OAuth 设备流登录（复刻自 qoder2api device_login.go）。

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use crate::account::{AccountInput, PlanSnapshot};
use crate::crypto::{machine_id_fallback, uuid};
use crate::editions::Edition;
use crate::paths::{machine_id_path, shared_client_cache_dir};
use std::path::Path;

const POLL_TIMEOUT_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceTokenResult {
    pub token: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub refresh_token_expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub login_id: String,
    pub verification_uri: String,
    pub expires_in: i64,
}

#[derive(Debug, Clone)]
pub struct LoginOutcome {
    pub status: String,
    pub account: Option<AccountInput>,
    pub error: Option<String>,
}

#[derive(Clone)]
struct PendingState {
    login_id: String,
    nonce: String,
    verifier: String,
    machine_id: String,
    machine_token: String,
    machine_type: String,
    expires_at: i64,
    edition_value: String,
}

static PENDING: LazyLock<Mutex<HashMap<String, PendingState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn pending_map() -> std::sync::MutexGuard<'static, HashMap<String, PendingState>> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

fn pkce_verifier() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

/// 读取本机 Qoder 客户端的 machine 信息
pub fn read_machine_info(client_dir: Option<&Path>) -> (String, String, String) {
    let mut machine_id = String::new();
    let mut machine_token = String::new();
    let mut machine_type = String::new();
    if let Some(dir) = client_dir {
        let p = machine_id_path(dir);
        if let Ok(text) = std::fs::read_to_string(&p) {
            machine_id = text.trim().to_string();
        }
        let token_file = shared_client_cache_dir(dir).join("cache").join("machine_token.json");
        if let Ok(text) = std::fs::read_to_string(&token_file) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                machine_token = json.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
                machine_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
            }
        }
    }
    if machine_id.is_empty() {
        machine_id = machine_id_fallback();
    }
    (machine_id, machine_token, machine_type)
}

/// 发起登录，返回验证 URL
pub fn start_login(edition: &Edition, client_dir: Option<&Path>) -> LoginResponse {
    let nonce = uuid().replace('-', "");
    let verifier = pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    let login_id = uuid().replace('-', "");
    let (machine_id, machine_token, machine_type) = read_machine_info(client_dir);

    let mut url = url::Url::parse(&edition.oauth.login_base_url).expect("login url");
    url.query_pairs_mut()
        .append_pair("nonce", &nonce)
        .append_pair("challenge", &challenge)
        .append_pair("challenge_method", "S256")
        .append_pair("client_id", &edition.oauth.client_id);
    if !machine_id.is_empty() {
        url.query_pairs_mut().append_pair("machine_id", &machine_id);
    }

    let state = PendingState {
        login_id: login_id.clone(),
        nonce,
        verifier,
        machine_id,
        machine_token,
        machine_type,
        expires_at: crate::crypto::now_ms() + POLL_TIMEOUT_MS,
        edition_value: edition.value.clone(),
    };
    {
        let mut map = pending_map();
        if map.len() > 20 {
            if let Some(oldest) = map.keys().next().cloned() {
                map.remove(&oldest);
            }
        }
        map.insert(login_id.clone(), state);
    }
    LoginResponse {
        login_id,
        verification_uri: url.to_string(),
        expires_in: POLL_TIMEOUT_MS,
    }
}

pub fn cancel_login(login_id: &str) {
    let mut map = pending_map();
    map.remove(login_id);
}

/// 轮询一次设备流
pub async fn poll_login(login_id: &str) -> LoginOutcome {
    let state = {
        let map = pending_map();
        match map.get(login_id) {
            Some(s) => s.clone(),
            None => {
                return LoginOutcome {
                    status: "error".into(),
                    account: None,
                    error: Some("登录会话不存在或已过期，请重新发起".into()),
                }
            }
        }
    };
    if crate::crypto::now_ms() > state.expires_at {
        cancel_login(login_id);
        return LoginOutcome {
            status: "error".into(),
            account: None,
            error: Some("登录已超时，请重试".into()),
        };
    }
    let edition = crate::editions::edition_of(&state.edition_value);

    let mut poll_url = url::Url::parse(&format!(
        "{}{}",
        edition.oauth.open_api_base_url, edition.oauth.poll_path
    ))
    .expect("poll url");
    poll_url
        .query_pairs_mut()
        .append_pair("nonce", &state.nonce)
        .append_pair("verifier", &state.verifier)
        .append_pair("challenge_method", "S256");

    let client = reqwest::Client::new();
    let resp = match client.get(poll_url.as_str()).send().await {
        Ok(r) => r,
        Err(e) => {
            return LoginOutcome {
                status: "pending".into(),
                account: None,
                error: Some(e.to_string()),
            }
        }
    };
    let status = resp.status();
    if status.as_u16() == 404 {
        return LoginOutcome {
            status: "pending".into(),
            account: None,
            error: None,
        };
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return LoginOutcome {
            status: "error".into(),
            account: None,
            error: Some(format!("轮询失败 HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>())),
        };
    }
    let token: DeviceTokenResult = match resp.json().await {
        Ok(t) => t,
        Err(e) => {
            return LoginOutcome {
                status: "error".into(),
                account: None,
                error: Some(format!("解析 device token 失败: {}", e)),
            }
        }
    };
    if token.token.is_empty() {
        return LoginOutcome {
            status: "pending".into(),
            account: None,
            error: None,
        };
    }
    cancel_login(login_id);

    // 拉取用户详情
    let auth_header = format!("Bearer {}", token.token);
    let user_info = fetch_json(
        &client,
        &format!("{}{}", edition.oauth.open_api_base_url, edition.oauth.user_info_path),
        &[("Authorization", auth_header.as_str())],
    )
    .await;

    let mut status_headers: Vec<(&str, String)> = vec![
        ("Authorization", auth_header.clone()),
        ("Cosy-ClientType", "0".into()),
        (
            "Cosy-MachineOS",
            format!(
                "{}_{}",
                if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" },
                if cfg!(target_os = "macos") { "darwin" } else if cfg!(target_os = "linux") { "linux" } else { "windows" }
            ),
        ),
    ];
    if !state.machine_token.is_empty() {
        status_headers.push(("Cosy-MachineToken", state.machine_token.clone()));
    }
    if !state.machine_type.is_empty() {
        status_headers.push(("Cosy-MachineType", state.machine_type.clone()));
    }
    let status_headers_ref: Vec<(&str, &str)> = status_headers
        .iter()
        .map(|(k, v)| (*k, v.as_str()))
        .collect();
    let user_status = fetch_json(
        &client,
        &format!("{}{}", edition.oauth.open_api_base_url, edition.oauth.user_status_path),
        &status_headers_ref,
    )
    .await;

    if let Some(s) = &user_status {
        if let Some(ws) = s.get("whitelistStatus").and_then(|v| v.as_str()) {
            let msg = match ws {
                "NoIpPermission" => Some("企业设置了 IP 白名单，当前 IP 无法登录"),
                "AppDisable" => Some("Qoder 应用已被停用"),
                "LoginExpire" => Some("Qoder 登录已失效，请重试"),
                "NotAllow" | "NOT_ALLOW" => Some("当前账号暂无 Qoder 使用权限"),
                _ => None,
            };
            if let Some(m) = msg {
                return LoginOutcome {
                    status: "error".into(),
                    account: None,
                    error: Some(m.into()),
                };
            }
        }
    }

    let user_plan = fetch_json(
        &client,
        &format!("{}{}", edition.oauth.open_api_base_url, edition.oauth.user_plan_path),
        &[("Authorization", auth_header.as_str())],
    )
    .await;

    let status_json = user_status.unwrap_or(serde_json::Value::Null);
    let info_json = user_info.unwrap_or(serde_json::Value::Null);
    let plan_json = user_plan.unwrap_or(serde_json::Value::Null);

    let uid = status_json
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or(&token.user_id)
        .to_string();
    let uid = if uid.is_empty() {
        info_json.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()
    } else {
        uid
    };

    let plan_tier_name = plan_json
        .get("plan_tier_name")
        .or_else(|| plan_json.get("planTierName"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let plan = if plan_tier_name.is_empty() {
        None
    } else {
        Some(PlanSnapshot {
            user_type: plan_json
                .get("user_type")
                .or_else(|| plan_json.get("userType"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            plan_tier_name,
            end_date: plan_json
                .get("end_date")
                .or_else(|| plan_json.get("endDate"))
                .and_then(json_ms),
        })
    };

    let account = AccountInput {
        edition: Some(edition.value.clone()),
        label: String::new(),
        name: info_json
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| status_json.get("name").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        email: info_json
            .get("email")
            .and_then(|v| v.as_str())
            .or_else(|| status_json.get("email").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        phone: info_json
            .get("phone")
            .and_then(|v| v.as_str())
            .or_else(|| status_json.get("phone").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        avatar_url: info_json
            .get("avatarUrl")
            .and_then(|v| v.as_str())
            .or_else(|| info_json.get("avatar_url").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string(),
        uid,
        aid: String::new(),
        yx_uid: status_json
            .get("yxUid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        org_id: status_json
            .get("orgId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        org_name: status_json
            .get("orgName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        user_type: status_json
            .get("userType")
            .and_then(|v| v.as_str())
            .unwrap_or("personal_standard")
            .to_string(),
        security_oauth_token: token.token.clone(),
        refresh_token: token.refresh_token.clone(),
        token_expire_at: Some(serde_json::json!(token.expires_at)),
        refresh_token_expires_at: Some(serde_json::json!(token.refresh_token_expires_at)),
        pat: String::new(),
        machine_id: state.machine_id.clone(),
        machine_token: state.machine_token.clone(),
        machine_type: state.machine_type.clone(),
        group: String::new(),
        auth_source: "oauth".into(),
        quota: None,
        plan,
        last_switch_at: None,
    };

    LoginOutcome {
        status: "done".into(),
        account: Some(account),
        error: None,
    }
}

fn json_ms(value: &serde_json::Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(if n < 1_000_000_000_000 { n * 1000 } else { n });
    }
    value.as_str().and_then(|raw| {
        chrono::DateTime::parse_from_rfc3339(raw)
            .ok()
            .map(|date| date.timestamp_millis())
    })
}

async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&str, &str)],
) -> Option<serde_json::Value> {
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    req = req.header("Accept", "application/json");
    match req.send().await {
        Ok(resp) if resp.status().is_success() => resp.json().await.ok(),
        _ => None,
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RefreshResult {
    #[serde(alias = "device_token", alias = "token", alias = "securityOauthToken")]
    pub security_oauth_token: String,
    #[serde(alias = "refresh_token", alias = "refreshToken")]
    pub refresh_token: Option<String>,
    #[serde(alias = "expires_at", alias = "expireTime")]
    pub expires_at: Option<serde_json::Value>,
}

/// 用 refresh_token 续期
pub async fn refresh_token(
    edition: &Edition,
    account: &crate::account::Account,
) -> Result<RefreshResult, String> {
    if account.refresh_token.is_empty() {
        return Err("账号没有 refresh_token，无法续期，请重新登录".into());
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "{}{}",
            edition.oauth.open_api_base_url, edition.oauth.refresh_path
        ))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "refresh_token": account.refresh_token }))
        .send()
        .await
        .map_err(|e| format!("刷新请求失败: {}", e))?;
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("刷新失败: {}", text.chars().take(200).collect::<String>()));
    }
    let result: RefreshResult = resp
        .json()
        .await
        .map_err(|e| format!("解析刷新响应失败: {}", e))?;
    if result.security_oauth_token.is_empty() {
        return Err("刷新响应缺少 token".into());
    }
    Ok(RefreshResult {
        security_oauth_token: result.security_oauth_token,
        refresh_token: Some(result.refresh_token.unwrap_or_else(|| account.refresh_token.clone())),
        expires_at: Some(result.expires_at.unwrap_or(serde_json::Value::Null)),
    })
}

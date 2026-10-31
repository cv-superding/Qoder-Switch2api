//! Qoder 账号信息查询：订阅计划、额度用量、签到活动（campaigns）、模型列表。

use serde_json::{json, Value};

use crate::account::{Account, QuotaPackage, QuotaPart};
use crate::cosy::{build_model_list_headers, legacy_decode};
use crate::editions::Edition;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaInfo {
    pub usage_type: String,
    pub total_usage_percentage: Option<f64>,
    pub is_quota_exceeded: bool,
    pub expires_at: Option<i64>,
    pub quota: Option<QuotaValue>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaValue {
    pub total: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub percentage: Option<f64>,
    pub unit: String,
    pub plan: Option<QuotaPart>,
    pub add_on: Option<QuotaPart>,
    pub packages: Vec<QuotaPackage>,
    pub shared: Option<QuotaPackage>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    pub user_type: String,
    pub plan_tier_name: String,
    pub is_personal_version: bool,
    pub start_date: Option<i64>,
    pub end_date: Option<i64>,
}

fn open_api(edition: &Edition, path: &str) -> String {
    format!("{}{}", edition.oauth.open_api_base_url.trim_end_matches('/'), path)
}

fn auth_header(account: &Account) -> String {
    format!("Bearer {}", if account.security_oauth_token.is_empty() { &account.pat } else { &account.security_oauth_token })
}

fn json_ms(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    let ms = if let Some(n) = value.as_f64() {
        let n = n as i64;
        if n < 1_000_000_000_000 { n * 1000 } else { n }
    } else if let Some(raw) = value.as_str() {
        if let Ok(n) = raw.trim().parse::<f64>() {
            let n = n as i64;
            if n < 1_000_000_000_000 { n * 1000 } else { n }
        } else {
            chrono::DateTime::parse_from_rfc3339(raw)
                .ok()
                .map(|date| date.timestamp_millis())?
        }
    } else {
        return None;
    };
    // 0 / 负数 / 9999-12-31 都表示「永不过期」
    if ms <= 0 || ms >= 4_102_444_800_000 {
        None
    } else {
        Some(ms)
    }
}

async fn get_json(edition: &Edition, account: &Account, path: &str) -> Result<Value, String> {
    let resp = crate::http::client()
        .get(open_api(edition, path))
        .header("Authorization", auth_header(account))
        .header("Accept", "application/json")
        // campaigns 缺少 Cosy 身份头会静默返回空活动列表
        .header("User-Agent", "Qoder")
        .header("Cosy-ClientType", "10")
        .header("Cosy-Version", "0.4.3")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn quota_part(value: Option<&Value>) -> Option<QuotaPart> {
    let q = value?;
    Some(QuotaPart {
        total: q.get("total").and_then(|v| v.as_f64()),
        used: q.get("used").and_then(|v| v.as_f64()),
        remaining: q.get("remaining").and_then(|v| v.as_f64()),
        percentage: q.get("percentage").and_then(|v| v.as_f64()),
        unit: q.get("unit").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    })
}

fn normalize_packages(raw: Option<&Value>) -> Vec<QuotaPackage> {
    raw.and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|p| {
                    let total = p.get("total").and_then(|v| v.as_f64());
                    let remaining = p.get("remaining").and_then(|v| v.as_f64());
                    if total.unwrap_or(0.0) <= 0.0 && remaining.unwrap_or(0.0) <= 0.0 {
                        return None;
                    }
                    Some(QuotaPackage {
                        id: p.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        name: p
                            .get("name")
                            .or_else(|| p.get("description"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("专属资源包")
                            .to_string(),
                        total,
                        used: p.get("used").and_then(|v| v.as_f64()),
                        remaining,
                        percentage: p.get("percentage").and_then(|v| v.as_f64()),
                        unit: p.get("unit").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        expires_at: json_ms(p.get("expiresAt")),
                        available: Some(p.get("available").and_then(|v| v.as_bool()).unwrap_or(true)),
                        unlimited: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_shared(raw: Option<&Value>) -> Option<QuotaPackage> {
    let v = raw?;
    if !v.is_object() {
        return None;
    }
    let cap = v.get("cap").or_else(|| v.get("total")).and_then(|x| x.as_f64());
    let remaining = v.get("remaining").and_then(|x| x.as_f64());
    if cap.is_none() && remaining.is_none() {
        return None;
    }
    Some(QuotaPackage {
        id: String::new(),
        name: "共享额度".into(),
        total: cap,
        used: v.get("used").and_then(|x| x.as_f64()),
        remaining,
        percentage: v.get("percentage").and_then(|x| x.as_f64()),
        unit: v.get("unit").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        expires_at: json_ms(v.get("expiresAt")),
        available: Some(v.get("available").and_then(|x| x.as_bool()).unwrap_or(true)),
        unlimited: Some(cap.map(|c| c < 0.0).unwrap_or(false)),
    })
}

/// 合并套餐额度、加油包、专属资源包与共享额度；上游 percentage 为「已用比例」
fn combine_quota(
    plan: Option<QuotaPart>,
    add_on: Option<QuotaPart>,
    packages: Vec<QuotaPackage>,
    shared: Option<QuotaPackage>,
) -> Option<QuotaValue> {
    // 上游可能返回 total=0 的空 addOnQuota，展示上没有意义
    let add_on = add_on.filter(|q| q.total.unwrap_or(0.0) > 0.0 || q.remaining.unwrap_or(0.0) > 0.0);
    let usable_packages: Vec<&QuotaPackage> = packages
        .iter()
        .filter(|p| p.available != Some(false))
        .collect();
    let usable_shared = shared
        .as_ref()
        .filter(|s| s.available != Some(false) && s.unlimited != Some(true));
    if plan.is_none() && add_on.is_none() && packages.is_empty() && shared.is_none() {
        return None;
    }
    let mut totals = [0.0_f64; 3];
    let mut seen = [false; 3];
    {
        let mut add = |total: Option<f64>, used: Option<f64>, remaining: Option<f64>| {
            for (i, value) in [total, used, remaining].into_iter().enumerate() {
                if let Some(v) = value {
                    totals[i] += v;
                    seen[i] = true;
                }
            }
        };
        if let Some(p) = &plan {
            add(p.total, p.used, p.remaining);
        }
        if let Some(a) = &add_on {
            add(a.total, a.used, a.remaining);
        }
        for pkg in &usable_packages {
            add(pkg.total, pkg.used, pkg.remaining);
        }
        if let Some(shared) = usable_shared {
            add(shared.total, shared.used, shared.remaining);
        }
    }
    let pick = |i: usize| if seen[i] { Some(totals[i]) } else { None };
    let total = pick(0);
    let used = pick(1);
    let percentage = total.zip(used).filter(|(t, _)| *t > 0.0).map(|(t, u)| u / t);
    let unit = plan
        .as_ref()
        .map(|p| p.unit.clone())
        .filter(|u| !u.is_empty())
        .or_else(|| add_on.as_ref().map(|a| a.unit.clone()).filter(|u| !u.is_empty()))
        .or_else(|| packages.first().map(|p| p.unit.clone()).filter(|u| !u.is_empty()))
        .or_else(|| shared.as_ref().map(|s| s.unit.clone()).filter(|u| !u.is_empty()))
        .unwrap_or_default();
    Some(QuotaValue {
        total,
        used,
        remaining: pick(2),
        percentage,
        unit,
        plan,
        add_on,
        packages,
        shared,
    })
}

pub async fn get_quota_usage(edition: &Edition, account: &Account) -> Result<QuotaInfo, String> {
    let data = get_json(edition, account, &edition.oauth.quota_usage_path).await?;
    let quota = combine_quota(
        quota_part(data.get("userQuota")),
        quota_part(data.get("addOnQuota")),
        normalize_packages(data.get("dedicatedResourcePackages")),
        normalize_shared(data.get("orgResourcePackage")),
    );
    Ok(QuotaInfo {
        usage_type: data.get("usageType").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        total_usage_percentage: data.get("totalUsagePercentage").and_then(|v| v.as_f64()),
        is_quota_exceeded: data.get("isQuotaExceeded").and_then(|v| v.as_bool()).unwrap_or(false),
        expires_at: json_ms(data.get("expiresAt")),
        quota,
    })
}

pub async fn get_user_plan(edition: &Edition, account: &Account) -> Result<PlanInfo, String> {
    let data = get_json(edition, account, &edition.oauth.user_plan_path).await?;
    Ok(PlanInfo {
        user_type: data
            .get("user_type")
            .or_else(|| data.get("userType"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        plan_tier_name: data
            .get("plan_tier_name")
            .or_else(|| data.get("planTierName"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        is_personal_version: data
            .get("is_personal_version")
            .or_else(|| data.get("isPersonalVersion"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        start_date: json_ms(data.get("start_date").or_else(|| data.get("startDate"))),
        end_date: json_ms(data.get("end_date").or_else(|| data.get("endDate"))),
    })
}

pub async fn get_me_usage(edition: &Edition, account: &Account) -> Option<Value> {
    get_json(edition, account, &edition.oauth.me_usage_path).await.ok()
}

/// 活动平台（campaigns / claim）请求头。
///
/// 国际版的「每日领取 100 Credits」要求**真实机器身份**：缺 Cosy-Machine*
/// 六头或发派生假头时，服务端会把签到活动整条过滤掉，只剩营销活动。
/// 只有原生桥返回真实身份时才发机器头（与官方桌面端一致）。
async fn campaign_headers(edition: &Edition, account: &Account, with_body: bool) -> Vec<(&'static str, String)> {
    let desktop_version = crate::switcher::find_client_exe(edition)
        .map(|exe| crate::machine_identity::client_version_from_exe(&exe, "0.4.8"))
        .unwrap_or_else(|| "0.4.8".to_string());
    let mut headers: Vec<(&'static str, String)> = vec![
        ("Authorization", auth_header(account)),
        ("Accept", "application/json".into()),
        ("User-Agent", "Qoder".into()),
        ("Cosy-ClientType", "10".into()),
        ("Cosy-Version", desktop_version),
    ];
    if let Some(ident) = crate::machine_identity::get_machine_identity(edition, &account.uid).await {
        headers.push(("Cosy-MachineId", crate::machine_identity::derive_machine_id(&account.uid)));
        headers.push(("Cosy-MachineToken", ident.machine_token));
        headers.push(("Cosy-MachineType", ident.machine_type));
        headers.push(("Cosy-MachineCode", ident.machine_code));
        headers.push(("Cosy-MachineOS", crate::machine_identity::machine_os().to_string()));
        if let Ok(host) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
            if !host.is_empty() {
                headers.push(("Cosy-MachineHostname", host));
            }
        }
    }
    if with_body {
        headers.push(("Content-Type", "application/json".into()));
    }
    headers
}

pub async fn list_campaigns(edition: &Edition, account: &Account) -> Result<Vec<Value>, String> {
    // 不带 forceRefresh：带上它会让未打开过活动页的账号被上游过滤掉每日签到行
    let headers = campaign_headers(edition, account, false).await;
    let mut req = crate::http::client().get(open_api(edition, &edition.oauth.campaigns_path));
    for (key, value) in headers {
        req = req.header(key, value);
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(match &data {
        Value::Array(arr) => arr.clone(),
        Value::Object(obj) => obj
            .get("campaigns")
            .or_else(|| {
                obj.get("data")
                    .and_then(|d| d.get("campaigns"))
                    .or_else(|| obj.get("data"))
            })
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    })
}

fn field<'a>(c: &'a Value, snake: &str, camel: &str) -> Option<&'a str> {
    c.get(snake)
        .and_then(|v| v.as_str())
        .or_else(|| c.get(camel).and_then(|v| v.as_str()))
}

fn campaign_action(c: &Value) -> String {
    field(c, "action_type", "actionType").unwrap_or("").trim().to_ascii_uppercase()
}

fn campaign_status(c: &Value) -> String {
    field(c, "claim_status", "claimStatus").unwrap_or("").trim().to_ascii_uppercase()
}

fn campaign_amount(c: &Value) -> f64 {
    c.get("benefit")
        .and_then(|b| b.get("amount"))
        .and_then(|v| v.as_f64())
        .or_else(|| c.get("rewardCredit").and_then(|v| v.as_f64()))
        .or_else(|| c.get("reward_credit").and_then(|v| v.as_f64()))
        .or_else(|| c.get("credit").and_then(|v| v.as_f64()))
        .unwrap_or(0.0)
}

fn campaign_kind(c: &Value) -> String {
    c.get("benefit")
        .and_then(|b| b.get("kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase()
}

/// 积分类活动：新版带 benefit.kind=CREDITS，部分老活动 kind 为空
fn is_credit_campaign(c: &Value) -> bool {
    let kind = campaign_kind(c);
    kind.is_empty() || kind == "CREDITS"
}

/// 活动时间窗（上游是秒级时间戳）
fn campaign_active(c: &Value, now_secs: i64) -> bool {
    let start_at = c
        .get("startAt")
        .or_else(|| c.get("start_at"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let end_at = c
        .get("endAt")
        .or_else(|| c.get("end_at"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if start_at > 0 && now_secs < start_at {
        return false;
    }
    if end_at > 0 && now_secs > end_at {
        return false;
    }
    true
}

fn value_id(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 可领取的签到活动（可同时存在多个）
pub fn find_claimable_checkins(campaigns: &[Value]) -> Vec<Value> {
    let now_secs = chrono::Utc::now().timestamp();
    campaigns
        .iter()
        .filter(|c| {
            let action = campaign_action(c);
            campaign_status(c) == "CLAIMABLE"
                && (action.is_empty() || action == "CLAIM_BENEFIT")
                && is_credit_campaign(c)
                && campaign_active(c, now_secs)
        })
        .filter_map(|c| {
            let id = c
                .get("id")
                .or_else(|| c.get("campaignId"))
                .or_else(|| c.get("campaign_id"))
                .and_then(value_id)?;
            Some(json!({
                "id": id,
                "name": field(c, "name", "title").unwrap_or("每日奖励"),
                "rewardCredit": if campaign_amount(c) > 0.0 { Some(campaign_amount(c)) } else { None }
            }))
        })
        .collect()
}

pub fn find_claimable_checkin(campaigns: &[Value]) -> Option<Value> {
    find_claimable_checkins(campaigns).into_iter().next()
}

/// 今日是否已签到：CLAIM_BENEFIT 直接算；老活动领取后降级成 VIEW_DETAILS
/// 但保留 CREDITS 金额的也算。纯营销 VIEW_DETAILS（无金额）不算。
pub fn today_checked_in(campaigns: &[Value]) -> bool {
    campaigns.iter().any(|c| {
        let status = campaign_status(c);
        if status != "CLAIMED" && status != "REPLAYED" {
            return false;
        }
        let action = campaign_action(c);
        if action == "CLAIM_BENEFIT" {
            return true;
        }
        (action.is_empty() || action == "VIEW_DETAILS")
            && campaign_kind(c) == "CREDITS"
            && campaign_amount(c) > 0.0
    })
}

/// 领取奖励：POST /sash/api/v1/me/campaigns/{id}/claim（幂等）
pub async fn claim_campaign(edition: &Edition, account: &Account, campaign_id: &str) -> Result<Value, String> {
    let url = format!(
        "{}/{}/claim",
        open_api(edition, &edition.oauth.claim_path).trim_end_matches('/'),
        campaign_id
    );
    let headers = campaign_headers(edition, account, true).await;
    let mut req = crate::http::client().post(&url).body("{}");
    for (key, value) in headers {
        req = req.header(key, value);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("领取失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let data: Value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::Null)
    };
    let body = data.get("data").filter(|v| v.is_object()).unwrap_or(&data);
    let failure_code = body
        .get("failureCode")
        .or_else(|| body.get("failure_code"))
        .or_else(|| body.get("errorCode"))
        .or_else(|| data.get("failureCode"))
        .or_else(|| data.get("errorCode"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    let replayed_already = |code: &str| {
        code == "SAME_PERSON_ALREADY_CLAIMED" || code == "ALREADY_CLAIMED" || code == "REPLAYED"
    };
    if !status.is_success() {
        if status.as_u16() == 409 && replayed_already(&failure_code) {
            return Ok(json!({ "success": true, "replayed": true, "rewardCredit": Value::Null }));
        }
        return Err(format!("HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    if !failure_code.is_empty() {
        if replayed_already(&failure_code) {
            return Ok(json!({ "success": true, "replayed": true, "rewardCredit": Value::Null }));
        }
        let message = match failure_code.as_str() {
            "REDEMPTION_CODE_OUT_OF_STOCK" => "今日奖励已被领完",
            "ACHIEVEMENT_NOT_COMPLETED" => "活动条件未完成",
            "CAMPAIGN_NOT_ACTIVE" => "活动未开始或已结束",
            "RISK_BLOCKED" => "风控拦截，请稍后再试",
            "RISK_DEPENDENCY_UNAVAILABLE" => "风控服务暂不可用，请稍后再试",
            _ => "活动暂不可领取，请稍后再试",
        };
        return Err(message.to_string());
    }
    let claim_status = body.get("status").and_then(|v| v.as_str()).unwrap_or("").to_ascii_uppercase();
    if claim_status == "BLOCKED" {
        return Err("活动暂不可领取，请稍后再试".into());
    }
    let replayed = body.get("replayed").and_then(|v| v.as_bool()).unwrap_or(false)
        || data.get("replayed").and_then(|v| v.as_bool()).unwrap_or(false);
    if !replayed
        && !claim_status.is_empty()
        && claim_status != "CLAIMED"
        && claim_status != "GRANTED"
        && claim_status != "SUCCESS"
    {
        return Err(format!("上游未确认领取成功（status={}）", claim_status));
    }
    let reward = body
        .get("benefit")
        .and_then(|b| b.get("amount"))
        .and_then(|v| v.as_f64())
        .or_else(|| body.get("rewardCredit").and_then(|v| v.as_f64()))
        .or_else(|| body.get("credit").and_then(|v| v.as_f64()))
        .filter(|v| *v > 0.0);
    Ok(json!({
        "success": true,
        "replayed": replayed,
        "rewardCredit": reward
    }))
}

/// 拉取上游可用模型列表。
/// 需要 Cosy 签名（签名路径剥 /algo、GET 无 body），国际版按 api1 → api2 → api3 兜底。
pub async fn fetch_model_list(edition: &Edition, account: &Account) -> Result<Vec<Value>, String> {
    let mut urls = vec![edition.legacy.model_list_url.clone()];
    urls.extend(edition.legacy.model_list_fallbacks.iter().cloned());
    let mut last_error = String::new();
    for url in urls {
        let headers = build_model_list_headers(account, edition, &url);
        let mut request = crate::http::client()
            .get(&url)
            .timeout(std::time::Duration::from_secs(20));
        for (key, value) in &headers {
            request = request.header(key, value);
        }
        match request.send().await {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                if !status.is_success() {
                    last_error = format!("HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>());
                    continue;
                }
                let payload: Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => serde_json::from_str(&legacy_decode(&text)).unwrap_or(Value::Null),
                };
                let models = extract_models(&payload);
                if !models.is_empty() {
                    return Ok(models);
                }
                last_error = "上游未返回模型列表".into();
            }
            Err(e) => {
                last_error = format!("请求失败: {}", e);
            }
        }
    }
    if last_error.is_empty() || last_error == "上游未返回模型列表" {
        Ok(Vec::new())
    } else {
        Err(last_error)
    }
}

fn extract_models(payload: &Value) -> Vec<Value> {
    // 新版响应顶层按场景分组：chat / developer / inline / quest ...
    let candidates = [
        payload.get("chat"),
        payload.get("models"),
        payload.get("data"),
        payload.get("body"),
        payload.get("list"),
    ];
    for c in candidates.into_iter().flatten() {
        if let Some(arr) = c.as_array() {
            return arr.iter().filter_map(normalize_model).collect();
        }
        if let Some(s) = c.as_str() {
            if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(s) {
                return arr.iter().filter_map(normalize_model).collect();
            }
        }
    }
    if let Value::Array(arr) = payload {
        return arr.iter().filter_map(normalize_model).collect();
    }
    Vec::new()
}

fn normalize_model(m: &Value) -> Option<Value> {
    if let Some(s) = m.as_str() {
        return Some(json!({ "id": s, "displayName": s, "ownedBy": "qoder" }));
    }
    if m.get("enable").and_then(|v| v.as_bool()) == Some(false)
        || m.get("enabled").and_then(|v| v.as_bool()) == Some(false)
    {
        return None;
    }
    let id = m
        .get("key")
        .or_else(|| m.get("id"))
        .or_else(|| m.get("model"))
        .or_else(|| m.get("name"))
        .and_then(|v| v.as_str())?;
    Some(json!({
        "id": id,
        "displayName": m.get("display_name").or_else(|| m.get("displayName")).or_else(|| m.get("name")).and_then(|v| v.as_str()).unwrap_or(id),
        "ownedBy": m.get("source").and_then(|v| v.as_str()).unwrap_or("qoder"),
        "isReasoning": m.get("is_reasoning").and_then(|v| v.as_bool()).unwrap_or(false),
        "isVl": m.get("is_vl").and_then(|v| v.as_bool()).unwrap_or(false)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_details_rows_do_not_count_as_checkin() {
        let campaigns = vec![json!({
            "campaignId": "mkt",
            "actionType": "VIEW_DETAILS",
            "claimStatus": "CLAIMED"
        })];
        assert!(!today_checked_in(&campaigns));
    }

    #[test]
    fn claimed_benefit_row_counts_as_checkin() {
        let campaigns = vec![json!({
            "campaignId": "daily",
            "actionType": "CLAIM_BENEFIT",
            "claimStatus": "CLAIMED",
            "benefit": { "kind": "CREDITS", "amount": 100 }
        })];
        assert!(today_checked_in(&campaigns));
    }

    #[test]
    fn claimable_rows_ignore_inactive_window() {
        let past = json!({
            "campaignId": "past",
            "actionType": "CLAIM_BENEFIT",
            "claimStatus": "CLAIMABLE",
            "startAt": 1_000,
            "endAt": 2_000,
            "benefit": { "kind": "CREDITS", "amount": 100 }
        });
        let active = json!({
            "campaignId": "active",
            "actionType": "CLAIM_BENEFIT",
            "claimStatus": "CLAIMABLE",
            "benefit": { "kind": "CREDITS", "amount": 100 }
        });
        let rows = find_claimable_checkins(&[past, active]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("id").and_then(|v| v.as_str()), Some("active"));
    }

    #[test]
    fn downgraded_claimed_credit_row_counts_as_checkin() {
        let campaigns = vec![json!({
            "campaignId": "daily",
            "actionType": "VIEW_DETAILS",
            "claimStatus": "CLAIMED",
            "benefit": { "kind": "CREDITS", "amount": 100 }
        })];
        assert!(today_checked_in(&campaigns));
    }

    #[test]
    fn quota_packages_join_totals_and_unlimited_shared_is_ignored() {
        let quota = combine_quota(
            Some(QuotaPart { total: Some(300.0), used: Some(100.0), remaining: Some(200.0), percentage: None, unit: "credits".into() }),
            Some(QuotaPart { total: Some(500.0), used: Some(0.0), remaining: Some(500.0), percentage: None, unit: "credits".into() }),
            vec![
                QuotaPackage { name: "包".into(), total: Some(1000.0), used: Some(200.0), remaining: Some(800.0), available: Some(true), ..Default::default() },
                QuotaPackage { name: "不可用".into(), total: Some(999.0), used: Some(0.0), remaining: Some(999.0), available: Some(false), ..Default::default() },
            ],
            Some(QuotaPackage { name: "共享".into(), total: Some(-1.0), remaining: Some(1_000_000.0), available: Some(true), unlimited: Some(true), ..Default::default() }),
        ).expect("quota");
        assert_eq!(quota.total, Some(1800.0));
        assert_eq!(quota.remaining, Some(1500.0));
        assert_eq!(quota.packages.len(), 2);
        assert_eq!(quota.shared.and_then(|s| s.unlimited), Some(true));
    }

    #[test]
    fn numeric_string_expiry_is_parsed() {
        assert_eq!(json_ms(Some(&json!("1792724800000"))), Some(1_792_724_800_000));
        assert_eq!(json_ms(Some(&json!("1792724800"))), Some(1_792_724_800_000));
        assert_eq!(json_ms(Some(&json!(1792724800.0))), Some(1_792_724_800_000));
    }

    #[test]
    fn permanent_expiry_is_normalized_to_none() {
        assert_eq!(json_ms(Some(&json!(253_402_214_400_000_i64))), None);
        assert_eq!(json_ms(Some(&json!(0))), None);
        assert_eq!(json_ms(Some(&json!(1_792_724_800_000_i64))), Some(1_792_724_800_000));
    }
}

//! Qoder 账号信息查询：订阅计划、额度用量、签到活动（campaigns）、模型列表。

use serde_json::{json, Value};

use crate::account::{Account, QuotaPart};
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
    format!("Bearer {}", if account.pat.is_empty() { &account.security_oauth_token } else { &account.pat })
}

fn json_ms(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(n) = value.as_i64() {
        return Some(if n < 1_000_000_000_000 { n * 1000 } else { n });
    }
    value.as_str().and_then(|raw| {
        chrono::DateTime::parse_from_rfc3339(raw)
            .ok()
            .map(|date| date.timestamp_millis())
    })
}

async fn get_json(edition: &Edition, account: &Account, path: &str) -> Result<Value, String> {
    let resp = crate::http::client()
        .get(open_api(edition, path))
        .header("Authorization", auth_header(account))
        .header("Accept", "application/json")
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

/// 合并套餐额度与加油包（addOnQuota）；上游 percentage 为「已用比例」
fn combine_quota(plan: Option<QuotaPart>, add_on: Option<QuotaPart>) -> Option<QuotaValue> {
    // 上游可能返回 total=0 的空 addOnQuota，展示上没有意义
    let add_on = add_on.filter(|q| q.total.unwrap_or(0.0) > 0.0 || q.remaining.unwrap_or(0.0) > 0.0);
    let (total, used, remaining, percentage, unit) = match (&plan, &add_on) {
        (None, None) => return None,
        (Some(plan), None) => {
            (plan.total, plan.used, plan.remaining, plan.percentage, plan.unit.clone())
        }
        (None, Some(add_on)) => (
            add_on.total,
            add_on.used,
            add_on.remaining,
            add_on.percentage,
            add_on.unit.clone(),
        ),
        (Some(plan), Some(add_on)) => {
            let total = plan.total.zip(add_on.total).map(|(a, b)| a + b);
            let used = plan.used.zip(add_on.used).map(|(a, b)| a + b);
            let remaining = plan.remaining.zip(add_on.remaining).map(|(a, b)| a + b);
            let percentage = total
                .zip(used)
                .filter(|(total, _)| *total > 0.0)
                .map(|(total, used)| used / total);
            let unit = if plan.unit.is_empty() {
                add_on.unit.clone()
            } else {
                plan.unit.clone()
            };
            (total, used, remaining, percentage, unit)
        }
    };
    Some(QuotaValue {
        total,
        used,
        remaining,
        percentage,
        unit,
        plan,
        add_on,
    })
}

pub async fn get_quota_usage(edition: &Edition, account: &Account) -> Result<QuotaInfo, String> {
    let data = get_json(edition, account, &edition.oauth.quota_usage_path).await?;
    let quota = combine_quota(
        quota_part(data.get("userQuota")),
        quota_part(data.get("addOnQuota")),
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

pub async fn list_campaigns(edition: &Edition, account: &Account) -> Result<Vec<Value>, String> {
    let data = get_json(edition, account, &edition.oauth.campaigns_path).await?;
    Ok(match &data {
        Value::Array(arr) => arr.clone(),
        Value::Object(obj) => obj
            .get("campaigns")
            .or_else(|| obj.get("data"))
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

/// 积分类活动：新版带 benefit.kind=CREDITS，部分老活动 kind 为空
fn is_credit_campaign(c: &Value) -> bool {
    let kind = c
        .get("benefit")
        .and_then(|b| b.get("kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    kind.is_empty() || kind == "CREDITS"
}

/// 可领取的签到活动（可同时存在多个）
pub fn find_claimable_checkins(campaigns: &[Value]) -> Vec<Value> {
    campaigns
        .iter()
        .filter(|c| {
            let action = campaign_action(c);
            campaign_status(c) == "CLAIMABLE"
                && (action.is_empty() || action == "CLAIM_BENEFIT")
                && is_credit_campaign(c)
        })
        .filter_map(|c| {
            let id = c
                .get("id")
                .or_else(|| c.get("campaignId"))
                .and_then(|v| v.as_str())?;
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

/// 今日是否已签到：只认积分类活动的 CLAIMED / REPLAYED
pub fn today_checked_in(campaigns: &[Value]) -> bool {
    campaigns.iter().any(|c| {
        let status = campaign_status(c);
        (status == "CLAIMED" || status == "REPLAYED")
            && (is_credit_campaign(c) || campaign_amount(c) > 0.0)
    })
}

/// 领取奖励：POST /sash/api/v1/me/campaigns/{id}/claim（幂等）
pub async fn claim_campaign(edition: &Edition, account: &Account, campaign_id: &str) -> Result<Value, String> {
    let url = format!(
        "{}/{}/claim",
        open_api(edition, &edition.oauth.claim_path).trim_end_matches('/'),
        campaign_id
    );
    let resp = crate::http::client()
        .post(&url)
        .header("Authorization", auth_header(account))
        .send()
        .await
        .map_err(|e| format!("领取失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let data: Value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::Null)
    };
    Ok(json!({
        "success": true,
        "replayed": data.get("replayed").and_then(|v| v.as_bool()).unwrap_or(false),
        "rewardCredit": data.get("rewardCredit").or_else(|| data.get("credit")).and_then(|v| v.as_f64())
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

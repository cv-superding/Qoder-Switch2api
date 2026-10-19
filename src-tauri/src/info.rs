//! Qoder 账号信息查询：订阅计划、额度用量、签到活动（campaigns）、模型列表。

use serde_json::{json, Value};

use crate::account::Account;
use crate::cosy::legacy_decode;
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

async fn get_json(edition: &Edition, account: &Account, path: &str) -> Result<Value, String> {
    let resp = reqwest::Client::new()
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

pub async fn get_quota_usage(edition: &Edition, account: &Account) -> Result<QuotaInfo, String> {
    let data = get_json(edition, account, &edition.oauth.quota_usage_path).await?;
    let quota = data.get("userQuota").map(|q| QuotaValue {
        total: q.get("total").and_then(|v| v.as_f64()),
        used: q.get("used").and_then(|v| v.as_f64()),
        remaining: q.get("remaining").and_then(|v| v.as_f64()),
        percentage: q.get("percentage").and_then(|v| v.as_f64()),
        unit: q.get("unit").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    });
    Ok(QuotaInfo {
        usage_type: data.get("usageType").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        total_usage_percentage: data.get("totalUsagePercentage").and_then(|v| v.as_f64()),
        is_quota_exceeded: data.get("isQuotaExceeded").and_then(|v| v.as_bool()).unwrap_or(false),
        expires_at: data.get("expiresAt").and_then(|v| v.as_i64()),
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
        start_date: data.get("start_date").and_then(|v| v.as_i64()),
        end_date: data.get("end_date").and_then(|v| v.as_i64()),
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

/// 找到今天可领取的签到活动
pub fn find_claimable_checkin(campaigns: &[Value]) -> Option<Value> {
    for c in campaigns {
        let action_type = field(c, "action_type", "actionType").unwrap_or("");
        let claim_status = field(c, "claim_status", "claimStatus").unwrap_or("");
        if action_type == "CLAIM_BENEFIT" && claim_status == "CLAIMABLE" {
            let id = field(c, "id", "campaignId").or_else(|| c.get("campaignId").and_then(|v| v.as_str()));
            return Some(json!({
                "id": id.unwrap_or(""),
                "name": field(c, "name", "title").unwrap_or("每日奖励"),
                "rewardCredit": c.get("rewardCredit")
                    .or_else(|| c.get("reward_credit"))
                    .or_else(|| c.get("credit"))
                    .and_then(|v| v.as_f64())
            }));
        }
    }
    None
}

pub fn today_checked_in(campaigns: &[Value]) -> bool {
    for c in campaigns {
        if field(c, "action_type", "actionType").unwrap_or("") != "CLAIM_BENEFIT" {
            continue;
        }
        let claim_status = field(c, "claim_status", "claimStatus").unwrap_or("");
        if claim_status == "CLAIMED" || claim_status == "REPLAYED" {
            return true;
        }
    }
    false
}

/// 领取奖励：POST /sash/api/v1/me/campaigns/{id}/claim（幂等）
pub async fn claim_campaign(edition: &Edition, account: &Account, campaign_id: &str) -> Result<Value, String> {
    let url = format!(
        "{}/{}/claim",
        open_api(edition, &edition.oauth.claim_path).trim_end_matches('/'),
        campaign_id
    );
    let resp = reqwest::Client::new()
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

/// 拉取上游可用模型列表（兼容明文 JSON / {body} 信封 / legacy 编码）
pub async fn fetch_model_list(edition: &Edition, account: &Account) -> Result<Vec<Value>, String> {
    let resp = reqwest::Client::new()
        .get(&edition.legacy.model_list_url)
        .header("Authorization", auth_header(account))
        .header("x-model-source", "system")
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // 与 Node 版一致：模型列表拉取失败静默降级为空列表（前端展示默认模型）
        return Ok(Vec::new());
    }
    let payload: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            let decoded = legacy_decode(&text);
            serde_json::from_str(&decoded).unwrap_or(Value::Null)
        }
    };
    Ok(extract_models(&payload))
}

fn extract_models(payload: &Value) -> Vec<Value> {
    let candidates = [
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

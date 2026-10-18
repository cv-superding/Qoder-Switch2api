//! 账号池：CRUD、按档位隔离、轮转、失败冷却、token 续期。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::crypto::{now_ms, random_id};
use crate::editions::{edition_of, Edition};
use crate::store::{load_encrypted, save_encrypted};

pub const COOLDOWN_MS: i64 = 120 * 1000;
pub const AUTH_ERROR_COOLDOWN_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub edition: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub avatar_url: String,
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub aid: String,
    #[serde(default)]
    pub yx_uid: String,
    #[serde(default)]
    pub org_id: String,
    #[serde(default)]
    pub org_name: String,
    #[serde(default = "default_user_type")]
    pub user_type: String,
    #[serde(default)]
    pub security_oauth_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub token_expire_at: Option<i64>,
    #[serde(default)]
    pub refresh_token_expire_at: Option<i64>,
    #[serde(default)]
    pub pat: String,
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub machine_token: String,
    #[serde(default)]
    pub machine_type: String,
    #[serde(default)]
    pub group: String,
    #[serde(default = "default_auth_source")]
    pub auth_source: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub last_error: String,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub last_switch_at: Option<i64>,
    #[serde(default)]
    pub quota: Option<QuotaSnapshot>,
    #[serde(default)]
    pub plan: Option<PlanSnapshot>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_user_type() -> String {
    "personal_standard".into()
}
fn default_auth_source() -> String {
    "manual".into()
}
fn default_status() -> String {
    "active".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaSnapshot {
    pub total: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub percentage: Option<f64>,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanSnapshot {
    #[serde(default)]
    pub user_type: String,
    #[serde(default)]
    pub plan_tier_name: String,
    #[serde(default)]
    pub end_date: Option<i64>,
}

/// 前端可见视图（不含明文 token）
#[derive(Debug, Clone, Serialize)]
pub struct AccountView {
    #[serde(flatten)]
    pub account: AccountMeta,
    pub has_token: bool,
    pub has_refresh_token: bool,
    pub has_pat: bool,
    pub token_mask: String,
    pub cooling: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountMeta {
    pub id: String,
    pub edition: String,
    pub label: String,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub avatar_url: String,
    pub uid: String,
    pub user_type: String,
    pub org_id: String,
    pub org_name: String,
    pub group: String,
    pub auth_source: String,
    pub status: String,
    pub last_error: String,
    pub last_used_at: Option<i64>,
    pub last_switch_at: Option<i64>,
    pub token_expire_at: Option<i64>,
    pub refresh_token_expire_at: Option<i64>,
    pub machine_id: String,
    pub quota: Option<QuotaSnapshot>,
    pub plan: Option<PlanSnapshot>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn to_meta(a: &Account) -> AccountMeta {
    AccountMeta {
        id: a.id.clone(),
        edition: a.edition.clone(),
        label: a.label.clone(),
        name: a.name.clone(),
        email: a.email.clone(),
        phone: a.phone.clone(),
        avatar_url: a.avatar_url.clone(),
        uid: a.uid.clone(),
        user_type: a.user_type.clone(),
        org_id: a.org_id.clone(),
        org_name: a.org_name.clone(),
        group: a.group.clone(),
        auth_source: a.auth_source.clone(),
        status: a.status.clone(),
        last_error: a.last_error.clone(),
        last_used_at: a.last_used_at,
        last_switch_at: a.last_switch_at,
        token_expire_at: a.token_expire_at,
        refresh_token_expire_at: a.refresh_token_expire_at,
        machine_id: a.machine_id.clone(),
        quota: a.quota.clone(),
        plan: a.plan.clone(),
        created_at: a.created_at,
        updated_at: a.updated_at,
    }
}

fn mask_token(token: &str) -> String {
    let t = token.trim();
    if t.chars().count() <= 12 {
        format!("{}***", t.chars().take(3).collect::<String>())
    } else {
        let head: String = t.chars().take(6).collect();
        let tail: String = t.chars().skip(t.chars().count() - 4).collect();
        format!("{}***{}", head, tail)
    }
}

/// 统一把到期时间规范为毫秒时间戳
fn to_ms(raw: &Option<serde_json::Value>) -> Option<i64> {
    let v = raw.as_ref()?;
    let ms = match v {
        serde_json::Value::Number(n) => n.as_f64()? as i64,
        serde_json::Value::String(s) => {
            if let Ok(n) = s.trim().parse::<i64>() {
                n
            } else if let Ok(f) = s.trim().parse::<f64>() {
                f as i64
            } else {
                // ISO 字符串
                chrono_lite::parse_iso_millis(s)?
            }
        }
        _ => return None,
    };
    if ms <= 0 {
        return None;
    }
    Some(if ms < 1_000_000_000_000 { ms * 1000 } else { ms })
}

/// 轻量 ISO8601 解析（避免引入 chrono 重量级依赖）
mod chrono_lite {
    pub fn parse_iso_millis(s: &str) -> Option<i64> {
        // 形如 2026-11-14T11:53:53Z / 2026-11-14T11:53:53.000Z
        let s = s.trim();
        let date_part = s.get(..10)?;
        let mut it = date_part.split('-');
        let year: i64 = it.next()?.parse().ok()?;
        let month: i64 = it.next()?.parse().ok()?;
        let day: i64 = it.next()?.parse().ok()?;
        let rest = s.get(11..)?;
        let mut it2 = rest.split(':');
        let hour: i64 = it2.next()?.parse().ok()?;
        let minute: i64 = it2.next()?.parse().ok()?;
        let sec_part = it2.next().unwrap_or("0");
        let sec: i64 = sec_part
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(0);
        let days = days_from_civil(year, month, day);
        Some(((days * 24 + hour) * 60 + minute) * 60 * 1000 + sec * 1000)
    }

    /// Howard Hinnant 的 days_from_civil 算法
    fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AccountInput {
    pub edition: Option<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub avatar_url: String,
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub aid: String,
    #[serde(default)]
    pub yx_uid: String,
    #[serde(default)]
    pub org_id: String,
    #[serde(default)]
    pub org_name: String,
    #[serde(default)]
    pub user_type: String,
    #[serde(default)]
    pub security_oauth_token: String,
    #[serde(default)]
    pub refresh_token: String,
    pub token_expire_at: Option<serde_json::Value>,
    pub refresh_token_expires_at: Option<serde_json::Value>,
    #[serde(default)]
    pub pat: String,
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub machine_token: String,
    #[serde(default)]
    pub machine_type: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub auth_source: String,
    pub quota: Option<QuotaSnapshot>,
    pub plan: Option<PlanSnapshot>,
    pub last_switch_at: Option<serde_json::Value>,
}

#[derive(Default)]
pub struct AccountManager {
    pub accounts: Vec<Account>,
    cooldowns: HashMap<String, i64>,
    rr: HashMap<String, AtomicUsize>,
    pub client_current: HashMap<String, Option<ClientCurrent>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClientCurrent {
    pub uid: String,
    pub name: String,
    pub email: String,
    pub id: String,
    pub at: i64,
}

impl AccountManager {
    pub fn load() -> Self {
        let accounts = load_encrypted::<Vec<Account>>("accounts.json");
        AccountManager {
            accounts,
            ..Default::default()
        }
    }

    pub fn save(&self) {
        save_encrypted("accounts.json", &self.accounts);
    }

    pub fn list_views(&self, edition: Option<&str>) -> Vec<AccountView> {
        self.accounts
            .iter()
            .filter(|a| edition.map(|e| a.edition == e).unwrap_or(true))
            .map(|a| self.view(a))
            .collect()
    }

    pub fn view(&self, a: &Account) -> AccountView {
        AccountView {
            account: to_meta(a),
            has_token: !a.security_oauth_token.is_empty(),
            has_refresh_token: !a.refresh_token.is_empty(),
            has_pat: !a.pat.is_empty(),
            token_mask: if !a.security_oauth_token.is_empty() {
                mask_token(&a.security_oauth_token)
            } else if !a.pat.is_empty() {
                mask_token(&a.pat)
            } else {
                String::new()
            },
            cooling: self.is_cooling(&a.id),
        }
    }

    pub fn get(&self, id: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.id == id)
    }

    pub fn add(&mut self, input: &AccountInput) -> Result<Account, String> {
        let edition = input.edition.clone().unwrap_or_else(|| "domestic".into());
        let edition = if edition == "international" { "international" } else { "domestic" };
        if input.security_oauth_token.is_empty() && input.pat.is_empty() {
            return Err("缺少登录凭证：需要 securityOauthToken 或 PAT".into());
        }
        let now = now_ms();
        let normalized = NormalizedAccount {
            label: input.label.clone(),
            name: input.name.clone(),
            email: input.email.clone(),
            phone: input.phone.clone(),
            avatar_url: input.avatar_url.clone(),
            uid: input.uid.clone(),
            aid: input.aid.clone(),
            yx_uid: input.yx_uid.clone(),
            org_id: input.org_id.clone(),
            org_name: input.org_name.clone(),
            user_type: if input.user_type.is_empty() {
                "personal_standard".into()
            } else {
                input.user_type.clone()
            },
            security_oauth_token: input.security_oauth_token.clone(),
            refresh_token: input.refresh_token.clone(),
            token_expire_at: to_ms(&input.token_expire_at),
            refresh_token_expires_at: to_ms(&input.refresh_token_expires_at),
            pat: input.pat.clone(),
            machine_id: input.machine_id.clone(),
            machine_token: input.machine_token.clone(),
            machine_type: input.machine_type.clone(),
            group: input.group.clone(),
            auth_source: if input.auth_source.is_empty() {
                "manual".into()
            } else {
                input.auth_source.clone()
            },
            quota: input.quota.clone(),
            plan: input.plan.clone(),
        };

        // 同档位同 uid 去重（覆盖更新）
        if !normalized.uid.is_empty() {
            if let Some(existing) = self
                .accounts
                .iter_mut()
                .find(|a| a.edition == edition && a.uid == normalized.uid)
            {
                apply_normalized(existing, &normalized, now);
                self.save();
                return Ok(existing.clone());
            }
        }

        let account = Account {
            id: random_id("acc"),
            edition: edition.to_string(),
            label: normalized.label.clone(),
            name: normalized.name.clone(),
            email: normalized.email.clone(),
            phone: normalized.phone.clone(),
            avatar_url: normalized.avatar_url.clone(),
            uid: normalized.uid.clone(),
            aid: normalized.aid.clone(),
            yx_uid: normalized.yx_uid.clone(),
            org_id: normalized.org_id.clone(),
            org_name: normalized.org_name.clone(),
            user_type: normalized.user_type.clone(),
            security_oauth_token: normalized.security_oauth_token.clone(),
            refresh_token: normalized.refresh_token.clone(),
            token_expire_at: normalized.token_expire_at,
            refresh_token_expires_at: normalized.refresh_token_expires_at,
            pat: normalized.pat.clone(),
            machine_id: normalized.machine_id.clone(),
            machine_token: normalized.machine_token.clone(),
            machine_type: normalized.machine_type.clone(),
            group: normalized.group.clone(),
            auth_source: normalized.auth_source.clone(),
            status: "active".into(),
            last_error: String::new(),
            last_used_at: None,
            last_switch_at: to_ms(&input.last_switch_at),
            quota: normalized.quota.clone(),
            plan: normalized.plan.clone(),
            created_at: now,
            updated_at: now,
        };
        self.accounts.push(account.clone());
        self.save();
        Ok(account)
    }

    pub fn update(&mut self, id: &str, patch: &serde_json::Value) -> Result<Account, String> {
        let account = self
            .accounts
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or_else(|| "账号不存在".to_string())?;
        if let Some(v) = patch.get("label").and_then(|v| v.as_str()) {
            account.label = v.into();
        }
        if let Some(v) = patch.get("group").and_then(|v| v.as_str()) {
            account.group = v.into();
        }
        if let Some(v) = patch.get("status").and_then(|v| v.as_str()) {
            account.status = v.into();
        }
        if let Some(v) = patch.get("name").and_then(|v| v.as_str()) {
            account.name = v.into();
        }
        if let Some(v) = patch.get("email").and_then(|v| v.as_str()) {
            account.email = v.into();
        }
        if let Some(v) = patch.get("phone").and_then(|v| v.as_str()) {
            account.phone = v.into();
        }
        if let Some(v) = patch.get("securityOauthToken").and_then(|v| v.as_str()) {
            account.security_oauth_token = v.into();
        }
        if let Some(v) = patch.get("refreshToken").and_then(|v| v.as_str()) {
            account.refresh_token = v.into();
        }
        if let Some(v) = patch.get("pat").and_then(|v| v.as_str()) {
            account.pat = v.into();
        }
        if let Some(v) = patch.get("machineId").and_then(|v| v.as_str()) {
            account.machine_id = v.into();
        }
        if let Some(v) = patch.get("machineToken").and_then(|v| v.as_str()) {
            account.machine_token = v.into();
        }
        if let Some(v) = patch.get("machineType").and_then(|v| v.as_str()) {
            account.machine_type = v.into();
        }
        if let Some(v) = patch.get("userType").and_then(|v| v.as_str()) {
            account.user_type = v.into();
        }
        if let Some(v) = patch.get("orgId").and_then(|v| v.as_str()) {
            account.org_id = v.into();
        }
        if let Some(v) = patch.get("orgName").and_then(|v| v.as_str()) {
            account.org_name = v.into();
        }
        if let Some(v) = patch.get("lastError").and_then(|v| v.as_str()) {
            account.last_error = v.into();
        }
        if let Some(v) = patch.get("tokenExpireAt").cloned() {
            account.token_expire_at = to_ms(&Some(v));
        }
        if let Some(v) = patch.get("refreshTokenExpiresAt").cloned() {
            account.refresh_token_expires_at = to_ms(&Some(v));
        }
        if let Some(v) = patch.get("lastUsedAt").cloned() {
            account.last_used_at = to_ms(&Some(v));
        }
        if let Some(v) = patch.get("lastSwitchAt").cloned() {
            account.last_switch_at = to_ms(&Some(v));
        }
        if let Some(v) = patch.get("quota").cloned() {
            account.quota = serde_json::from_value(v).ok();
        }
        if let Some(v) = patch.get("plan").cloned() {
            account.plan = serde_json::from_value(v).ok();
        }
        account.updated_at = now_ms();
        let result = account.clone();
        self.save();
        Ok(result)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.accounts.len();
        self.accounts.retain(|a| a.id != id);
        self.cooldowns.remove(id);
        self.save();
        before != self.accounts.len()
    }

    pub fn set_client_current(&mut self, edition: &str, summary: Option<ClientCurrent>) {
        self.client_current.insert(
            edition.to_string(),
            summary.map(|s| ClientCurrent { at: now_ms(), ..s }),
        );
    }

    pub fn is_cooling(&self, id: &str) -> bool {
        self.cooldowns
            .get(id)
            .map(|until| *until > now_ms())
            .unwrap_or(false)
    }

    fn proxy_candidates(&self, edition: &str, group: &str) -> Vec<&Account> {
        self.accounts
            .iter()
            .filter(|a| {
                a.edition == edition
                    && a.status != "disabled"
                    && !self.is_cooling(&a.id)
                    && !(group == "proxy" && a.group == "desktop")
                    && (!a.security_oauth_token.is_empty() || !a.pat.is_empty())
            })
            .collect()
    }

    /// 轮转选号：额度剩余多的优先，同级 round-robin
    pub fn pick(&mut self, edition_value: &str, group: &str) -> Option<Account> {
        let candidates = self.proxy_candidates(edition_value, group);
        if candidates.is_empty() {
            return None;
        }
        let now = now_ms();
        let usable: Vec<&Account> = candidates
            .iter()
            .copied()
            .filter(|a| a.token_expire_at.map(|t| t > now).unwrap_or(true) || !a.refresh_token.is_empty())
            .collect();
        let pool = if usable.is_empty() { candidates } else { usable };
        let mut sorted: Vec<&Account> = pool.clone();
        sorted.sort_by(|a, b| {
            let sa = quota_score(a);
            let sb = quota_score(b);
            sb.partial_cmp(&sa)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.last_used_at.unwrap_or(0).cmp(&b.last_used_at.unwrap_or(0)))
        });
        let idx = self
            .rr
            .entry(edition_value.to_string())
            .or_insert_with(|| AtomicUsize::new(0))
            .fetch_add(1, Ordering::SeqCst);
        let chosen = if sorted.len() > 1 {
            sorted[idx % sorted.len()]
        } else {
            sorted[0]
        };
        let id = chosen.id.clone();
        if let Some(a) = self.accounts.iter_mut().find(|a| a.id == id) {
            a.last_used_at = Some(now_ms());
            return Some(a.clone());
        }
        None
    }

    pub fn mark_success(&mut self, id: &str) {
        if let Some(a) = self.accounts.iter_mut().find(|a| a.id == id) {
            a.last_error = String::new();
            a.updated_at = now_ms();
        }
        self.cooldowns.remove(id);
    }

    pub fn mark_failure(&mut self, id: &str, status_code: u16, message: &str) {
        let until = now_ms()
            + if status_code == 401 || status_code == 403 {
                AUTH_ERROR_COOLDOWN_MS
            } else {
                COOLDOWN_MS
            };
        self.cooldowns.insert(id.to_string(), until);
        if let Some(a) = self.accounts.iter_mut().find(|a| a.id == id) {
            a.last_error = format!("HTTP {}: {}", status_code, message.chars().take(200).collect::<String>());
            a.updated_at = now_ms();
            if (status_code == 401 || status_code == 403) && a.refresh_token.is_empty() {
                a.status = "needs_relogin".into();
            }
        }
        self.save();
    }

    /// 尝试用 refresh_token 续期
    pub async fn try_refresh(&mut self, id: &str) -> bool {
        let account = match self.get(id) {
            Some(a) => a.clone(),
            None => return false,
        };
        if account.refresh_token.is_empty() {
            return false;
        }
        let edition = edition_of(&account.edition);
        match crate::oauth::refresh_token(&edition, &account).await {
            Ok(result) => {
                let _ = self.update(
                    id,
                    &serde_json::json!({
                        "securityOauthToken": result.security_oauth_token,
                        "refreshToken": result.refresh_token,
                        "tokenExpireAt": result.token_expire_at,
                        "status": "active",
                        "lastError": "",
                    }),
                );
                self.cooldowns.remove(id);
                true
            }
            Err(e) => {
                let _ = self.update(
                    id,
                    &serde_json::json!({
                        "status": "needs_relogin",
                        "lastError": format!("续期失败: {}", e),
                    }),
                );
                false
            }
        }
    }

    pub fn counts(&self) -> serde_json::Value {
        let mut domestic = 0i64;
        let mut international = 0i64;
        let mut proxy_domestic = 0i64;
        let mut proxy_international = 0i64;
        for a in &self.accounts {
            if a.edition == "international" {
                international += 1;
            } else {
                domestic += 1;
            }
            if a.group != "desktop"
                && a.status != "disabled"
                && (!a.security_oauth_token.is_empty() || !a.pat.is_empty())
            {
                if a.edition == "domestic" {
                    proxy_domestic += 1;
                } else {
                    proxy_international += 1;
                }
            }
        }
        serde_json::json!({
            "domestic": domestic,
            "international": international,
            "proxyDomestic": proxy_domestic,
            "proxyInternational": proxy_international,
        })
    }
}

struct NormalizedAccount {
    label: String,
    name: String,
    email: String,
    phone: String,
    avatar_url: String,
    uid: String,
    aid: String,
    yx_uid: String,
    org_id: String,
    org_name: String,
    user_type: String,
    security_oauth_token: String,
    refresh_token: String,
    token_expire_at: Option<i64>,
    refresh_token_expires_at: Option<i64>,
    pat: String,
    machine_id: String,
    machine_token: String,
    machine_type: String,
    group: String,
    auth_source: String,
    quota: Option<QuotaSnapshot>,
    plan: Option<PlanSnapshot>,
}

fn apply_normalized(account: &mut Account, n: &NormalizedAccount, now: i64) {
    account.label = n.label.clone();
    account.name = n.name.clone();
    account.email = n.email.clone();
    account.phone = n.phone.clone();
    account.avatar_url = n.avatar_url.clone();
    account.uid = n.uid.clone();
    account.aid = n.aid.clone();
    account.yx_uid = n.yx_uid.clone();
    account.org_id = n.org_id.clone();
    account.org_name = n.org_name.clone();
    account.user_type = n.user_type.clone();
    account.security_oauth_token = n.security_oauth_token.clone();
    account.refresh_token = n.refresh_token.clone();
    account.token_expire_at = n.token_expire_at;
    account.refresh_token_expires_at = n.refresh_token_expires_at;
    account.pat = n.pat.clone();
    account.machine_id = n.machine_id.clone();
    account.machine_token = n.machine_token.clone();
    account.machine_type = n.machine_type.clone();
    account.group = n.group.clone();
    account.auth_source = n.auth_source.clone();
    account.quota = n.quota.clone();
    account.plan = n.plan.clone();
    account.updated_at = now;
}

fn quota_score(a: &Account) -> f64 {
    match &a.quota {
        Some(q) => match (q.remaining, q.total) {
            (Some(remaining), Some(total)) if total > 0.0 => remaining / total,
            _ => 0.0,
        },
        None => 0.0,
    }
}

//! 反代用量统计：请求数、Token 消耗，按账号 / 模型 / 日期聚合。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::store::{load_json, save_json};

const MAX_RECORDS: usize = 5000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UsageRecord {
    pub ts: i64,
    #[serde(default)]
    pub edition: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub account_name: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub prompt_tokens: i64,
    #[serde(default)]
    pub completion_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default = "default_true")]
    pub success: bool,
    #[serde(default)]
    pub error: String,
    #[serde(default = "default_api")]
    pub api: String,
}

fn default_model() -> String {
    "auto".into()
}
fn default_true() -> bool {
    true
}
fn default_api() -> String {
    "chat".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UsageState {
    #[serde(default)]
    pub records: Vec<UsageRecord>,
}

pub fn record_usage(entry: UsageRecord) {
    let mut state = load_json::<UsageState>("usage.json");
    let mut record = entry;
    record.ts = crate::crypto::now_ms();
    state.records.push(record);
    if state.records.len() > MAX_RECORDS {
        let excess = state.records.len() - MAX_RECORDS;
        state.records.drain(..excess);
    }
    save_json("usage.json", &state);
}

fn day_key(ts: i64) -> String {
    let secs = ts / 1000;
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
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

#[derive(Debug, Clone, Default, Serialize)]
pub struct Bucket {
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub errors: i64,
}

fn merge_bucket(bucket: &mut Bucket, r: &UsageRecord) {
    bucket.requests += 1;
    bucket.prompt_tokens += r.prompt_tokens;
    bucket.completion_tokens += r.completion_tokens;
    bucket.total_tokens += r.total_tokens;
    if !r.success {
        bucket.errors += 1;
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageStats {
    pub totals: Bucket,
    pub by_account: Vec<(String, Bucket)>,
    pub by_model: Vec<(String, Bucket)>,
    pub by_api: Vec<(String, Bucket)>,
    pub daily: Vec<(String, Bucket)>,
    pub recent: Vec<UsageRecord>,
}

pub fn usage_stats(edition: Option<&str>) -> UsageStats {
    let state = load_json::<UsageState>("usage.json");
    let records: Vec<&UsageRecord> = state
        .records
        .iter()
        .filter(|r| edition.map(|e| r.edition == e).unwrap_or(true))
        .collect();

    let mut totals = Bucket::default();
    let mut by_account: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut by_model: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut by_api: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut by_day: BTreeMap<String, Bucket> = BTreeMap::new();

    for r in &records {
        merge_bucket(&mut totals, r);
        merge_bucket(by_account.entry(if r.account_name.is_empty() { "未知账号".into() } else { r.account_name.clone() }).or_default(), r);
        merge_bucket(by_model.entry(if r.model.is_empty() { "auto".into() } else { r.model.clone() }).or_default(), r);
        merge_bucket(by_api.entry(if r.api.is_empty() { "chat".into() } else { r.api.clone() }).or_default(), r);
        merge_bucket(by_day.entry(day_key(r.ts)).or_default(), r);
    }

    let mut by_account: Vec<(String, Bucket)> = by_account.into_iter().collect();
    by_account.sort_by(|a, b| b.1.requests.cmp(&a.1.requests));
    let mut by_model: Vec<(String, Bucket)> = by_model.into_iter().collect();
    by_model.sort_by(|a, b| b.1.requests.cmp(&a.1.requests));
    let mut by_api: Vec<(String, Bucket)> = by_api.into_iter().collect();
    by_api.sort_by(|a, b| b.1.requests.cmp(&a.1.requests));
    let daily: Vec<(String, Bucket)> = by_day.into_iter().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect();
    let mut recent: Vec<UsageRecord> = records.iter().rev().take(50).map(|r| (*r).clone()).collect();
    recent.reverse();

    UsageStats {
        totals,
        by_account,
        by_model,
        by_api,
        daily,
        recent,
    }
}

//! 反代用量统计：请求数、Token 消耗，按账号 / 模型 / 日期聚合。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::store::{load_json, save_json};

const MAX_RECORDS: usize = 5000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    use chrono::{Local, TimeZone};
    Local
        .timestamp_millis_opt(ts)
        .single()
        .unwrap_or_else(Local::now)
        .format("%Y-%m-%d")
        .to_string()
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
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

/// 前端形态：{ name, requests, promptTokens, ... }
#[derive(Debug, Clone, Serialize)]
pub struct NamedBucket {
    pub name: String,
    #[serde(flatten)]
    pub bucket: Bucket,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub totals: Bucket,
    pub by_account: Vec<NamedBucket>,
    pub by_model: Vec<NamedBucket>,
    pub by_api: Vec<NamedBucket>,
    pub daily: Vec<NamedBucket>,
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

    let mut by_account: Vec<NamedBucket> = by_account.into_iter().map(|(name, bucket)| NamedBucket { name, bucket }).collect();
    by_account.sort_by(|a, b| b.bucket.requests.cmp(&a.bucket.requests));
    let mut by_model: Vec<NamedBucket> = by_model.into_iter().map(|(name, bucket)| NamedBucket { name, bucket }).collect();
    by_model.sort_by(|a, b| b.bucket.requests.cmp(&a.bucket.requests));
    let mut by_api: Vec<NamedBucket> = by_api.into_iter().map(|(name, bucket)| NamedBucket { name, bucket }).collect();
    by_api.sort_by(|a, b| b.bucket.requests.cmp(&a.bucket.requests));
    let daily: Vec<NamedBucket> = by_day.into_iter().rev().take(30).collect::<Vec<_>>().into_iter().rev().map(|(name, bucket)| NamedBucket { name, bucket }).collect();
    // 与 Node 版一致：最新记录在前
    let recent: Vec<UsageRecord> = records.iter().rev().take(50).map(|r| (*r).clone()).collect();

    UsageStats {
        totals,
        by_account,
        by_model,
        by_api,
        daily,
        recent,
    }
}

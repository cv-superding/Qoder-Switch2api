//! 检查 GitHub Releases 是否有新版本（进程内缓存 30 分钟）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const REPO: &str = "cv-superding/Qoder-Switch2api";
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);

static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);

fn parse_version(raw: &str) -> [u64; 3] {
    let cleaned = raw.trim().trim_start_matches(['v', 'V']);
    let mut out = [0u64; 3];
    for (index, part) in cleaned.split(['.', '-', '+']).take(3).enumerate() {
        out[index] = part.parse::<u64>().unwrap_or(0);
    }
    out
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    parse_version(a).cmp(&parse_version(b))
}

fn normalize(release: &Value) -> Value {
    let tag = release.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
    let latest_version = tag.trim_start_matches(['v', 'V']).to_string();
    let current_version = env!("CARGO_PKG_VERSION");
    let assets = release
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|asset| {
                    json!({
                        "name": asset.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                        "url": asset.get("browser_download_url").and_then(|v| v.as_str()).unwrap_or(""),
                        "size": asset.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let download_url = assets
        .iter()
        .find(|asset| asset.get("name").and_then(|v| v.as_str()) == Some("qoder-switch2api.exe"))
        .or_else(|| {
            assets.iter().find(|asset| {
                asset
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|name| name.to_ascii_lowercase().ends_with(".exe"))
                    .unwrap_or(false)
            })
        })
        .and_then(|asset| asset.get("url").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    json!({
        "currentVersion": current_version,
        "latestVersion": latest_version,
        "hasUpdate": !latest_version.is_empty()
            && compare_versions(&latest_version, current_version) == std::cmp::Ordering::Greater,
        "releaseUrl": release.get("html_url").and_then(|v| v.as_str())
            .unwrap_or(&format!("https://github.com/{}/releases/latest", REPO)),
        "downloadUrl": download_url,
        "releaseName": release.get("name").and_then(|v| v.as_str()).unwrap_or(tag),
        "publishedAt": release.get("published_at").and_then(|v| v.as_str()),
        "notes": release.get("body").and_then(|v| v.as_str()).unwrap_or("").chars().take(2000).collect::<String>(),
    })
}

pub async fn check_update(force: bool) -> Result<Value, String> {
    if !force {
        if let Ok(guard) = CACHE.lock() {
            if let Some((at, data)) = guard.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return Ok(data.clone());
                }
            }
        }
    }
    let url = format!("https://api.github.com/repos/{}/releases/latest", REPO);
    let resp = crate::http::client()
        .get(&url)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "Qoder-Switch2api-update-check")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("更新检查失败: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("更新检查 HTTP {}: {}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let release: Value = serde_json::from_str(&text).map_err(|e| format!("解析更新信息失败: {}", e))?;
    let data = normalize(&release);
    if data.get("latestVersion").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        return Err("GitHub Releases 响应缺少版本号".into());
    }
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((Instant::now(), data.clone()));
    }
    Ok(data)
}

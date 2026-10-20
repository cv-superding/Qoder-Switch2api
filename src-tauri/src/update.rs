//! 检查 GitHub Releases 是否有新版本（进程内缓存 30 分钟）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const REPO: &str = "cv-superding/Qoder-Switch2api";
const API_URL: &str = "https://api.github.com/repos/cv-superding/Qoder-Switch2api/releases/latest";
const LATEST_URL: &str = "https://github.com/cv-superding/Qoder-Switch2api/releases/latest";
// 5 分钟缓存：新版本发布后最多 5 分钟就能被下一次检查看到
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);

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

/// GitHub API 限流 / 不可用时的兜底：releases/latest 跟随重定向，从最终 URL 取 tag
async fn check_via_html() -> Result<Value, String> {
    let resp = crate::http::client()
        .get(LATEST_URL)
        .header("user-agent", "Qoder-Switch2api-update-check")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Releases 页面请求失败: {}", e))?;
    let status = resp.status();
    let final_url = resp.url().as_str().to_string();
    if !status.is_success() {
        return Err(format!("Releases 页面 HTTP {}", status.as_u16()));
    }
    let tag = final_url
        .split("/releases/tag/")
        .nth(1)
        .map(|rest| rest.split(['?', '#']).next().unwrap_or(""))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "无法从 Releases 页面解析最新版本".to_string())?
        .to_string();
    let latest_version = tag.trim_start_matches(['v', 'V']).to_string();
    let current_version = env!("CARGO_PKG_VERSION");
    Ok(json!({
        "currentVersion": current_version,
        "latestVersion": latest_version,
        "hasUpdate": !latest_version.is_empty()
            && compare_versions(&latest_version, current_version) == std::cmp::Ordering::Greater,
        "releaseUrl": format!("https://github.com/{}/releases/tag/{}", REPO, tag),
        "downloadUrl": format!("https://github.com/{}/releases/download/{}/qoder-switch2api.exe", REPO, tag),
        "releaseName": tag,
        "publishedAt": null,
        "notes": "",
    }))
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
    let api_result = async {
        let resp = crate::http::client()
            .get(API_URL)
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
        Ok(data)
    }
    .await;
    let data = match api_result {
        Ok(data) => data,
        Err(api_error) => check_via_html()
            .await
            .map_err(|html_error| format!("{}；Releases 页面兜底也失败：{}", api_error, html_error))?,
    };
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((Instant::now(), data.clone()));
    }
    Ok(data)
}

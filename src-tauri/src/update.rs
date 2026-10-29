//! 检查 GitHub Releases 是否有新版本（进程内缓存 30 分钟）。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

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

fn normalize_proxy(value: &str) -> Option<String> {
    let raw = value.trim();
    if raw.is_empty() || raw.starts_with("socks") {
        return None;
    }
    Some(if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("http://{}", raw)
    })
}

/// 环境变量优先，其次 Windows 系统代理（代理工具通常只改注册表）
fn system_proxy() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        if let Ok(value) = std::env::var(key) {
            if let Some(proxy) = normalize_proxy(&value) {
                return Some(proxy);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::process::Command;
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
        let enabled = Command::new("reg")
            .args(["query", KEY, "/v", "ProxyEnable"])
            .output()
            .ok()?;
        if !String::from_utf8_lossy(&enabled.stdout).to_ascii_lowercase().contains("0x1") {
            return None;
        }
        let output = Command::new("reg")
            .args(["query", KEY, "/v", "ProxyServer"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        let mut server = text
            .lines()
            .find_map(|line| line.find("REG_SZ").map(|idx| line[idx + 6..].trim().to_string()))
            .unwrap_or_default();
        if server.contains('=') {
            server = server
                .split(';')
                .find_map(|part| part.strip_prefix("https=").or_else(|| part.strip_prefix("http=")))
                .unwrap_or("")
                .to_string();
        }
        return normalize_proxy(&server);
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn update_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout)
        .user_agent("Qoder-Switch2api-update-check");
    if let Some(proxy) = system_proxy() {
        builder = builder
            .proxy(reqwest::Proxy::all(&proxy).map_err(|e| format!("配置更新代理失败: {}", e))?);
    }
    builder.build().map_err(|e| format!("创建更新网络客户端失败: {}", e))
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
    let exe_asset = assets
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
        });
    let download_url = exe_asset
        .and_then(|asset| asset.get("url").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    let digest = exe_asset
        .and_then(|asset| asset.get("digest").and_then(|v| v.as_str()))
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
        "digest": digest,
        "releaseName": release.get("name").and_then(|v| v.as_str()).unwrap_or(tag),
        "publishedAt": release.get("published_at").and_then(|v| v.as_str()),
        "notes": release.get("body").and_then(|v| v.as_str()).unwrap_or("").chars().take(2000).collect::<String>(),
    })
}

/// GitHub API 限流 / 不可用时的兜底：releases/latest 跟随重定向，从最终 URL 取 tag
async fn check_via_html() -> Result<Value, String> {
    let resp = update_client(Duration::from_secs(20))?
        .get(LATEST_URL)
        .header("user-agent", "Qoder-Switch2api-update-check")
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
        "digest": "",
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
        let resp = update_client(Duration::from_secs(20))?
            .get(API_URL)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "Qoder-Switch2api-update-check")
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

/* ------------------------------------------------------------------ */
/* 内置下载与自替换                                                     */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStatus {
    pub state: String,
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
    pub path: String,
    pub error: String,
    pub version: String,
}

impl Default for DownloadStatus {
    fn default() -> Self {
        Self {
            state: "idle".into(),
            downloaded: 0,
            total: 0,
            percent: 0.0,
            path: String::new(),
            error: String::new(),
            version: String::new(),
        }
    }
}

static DOWNLOAD: OnceLock<Mutex<DownloadStatus>> = OnceLock::new();

fn download_state() -> &'static Mutex<DownloadStatus> {
    DOWNLOAD.get_or_init(|| Mutex::new(DownloadStatus::default()))
}

fn set_download(update: impl FnOnce(&mut DownloadStatus)) {
    if let Ok(mut guard) = download_state().lock() {
        update(&mut guard);
    }
}

pub fn get_download_status() -> Value {
    download_state()
        .lock()
        .ok()
        .and_then(|status| serde_json::to_value(&*status).ok())
        .unwrap_or_else(|| json!({}))
}

async fn download_file(url: &str, file: &std::path::Path, expected_digest: &str) -> Result<(), String> {
    let resp = update_client(Duration::from_secs(10 * 60))?
        .get(url)
        .header("user-agent", "Qoder-Switch2api-updater")
        .send()
        .await
        .map_err(|e| format!("下载失败: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载失败：HTTP {}", status.as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);
    set_download(|s| s.total = total);
    use tokio::io::AsyncWriteExt;
    let mut out = tokio::fs::File::create(file)
        .await
        .map_err(|e| format!("创建更新文件失败: {}", e))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded = 0u64;
    let mut hasher = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {}", e))?;
        hasher.update(&chunk);
        out.write_all(&chunk)
            .await
            .map_err(|e| format!("写入更新文件失败: {}", e))?;
        downloaded += chunk.len() as u64;
        set_download(|s| {
            s.downloaded = downloaded;
            s.percent = if total > 0 {
                (downloaded as f64 / total as f64 * 100.0).min(99.9)
            } else {
                0.0
            };
        });
    }
    out.flush().await.map_err(|e| format!("写入更新文件失败: {}", e))?;
    drop(out);
    let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    if size < 1024 * 1024 {
        return Err(format!("下载文件不完整（{} 字节）", size));
    }
    let expected = expected_digest
        .trim()
        .trim_start_matches("sha256:")
        .to_ascii_lowercase();
    if !expected.is_empty() {
        let actual = format!("{:x}", hasher.finalize());
        if actual != expected {
            return Err("更新包 SHA-256 校验失败".into());
        }
    }
    set_download(|s| {
        s.state = "done".into();
        s.downloaded = size;
        s.total = size;
        s.percent = 100.0;
        s.error.clear();
    });
    Ok(())
}

pub async fn start_download() -> Result<Value, String> {
    {
        let state = download_state().lock().map_err(|_| "下载状态锁失败".to_string())?;
        if state.state == "downloading" {
            drop(state);
            return Ok(get_download_status());
        }
    }
    let info = check_update(false).await?;
    if !info.get("hasUpdate").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err("当前已是最新版本".into());
    }
    let download_url = info
        .get("downloadUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    const PREFIX: &str = "https://github.com/cv-superding/Qoder-Switch2api/releases/download/";
    if !download_url.starts_with(PREFIX) {
        return Err("没有可用的更新下载地址".into());
    }
    let version = info
        .get("latestVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let dir = crate::paths::data_dir().join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {}", e))?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|ext| ext.eq_ignore_ascii_case("exe")).unwrap_or(false) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    let file = dir.join(format!(
        "qoder-switch2api-{}-{}.exe",
        version,
        crate::crypto::now_ms()
    ));
    {
        let mut state = download_state().lock().map_err(|_| "下载状态锁失败".to_string())?;
        *state = DownloadStatus {
            state: "downloading".into(),
            path: file.to_string_lossy().to_string(),
            version,
            ..Default::default()
        };
    }
    let digest = info
        .get("digest")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut candidates = vec![download_url.clone()];
    if !digest.is_empty() {
        // 直连 GitHub 资产域名不可用时，走镜像；最终仍用 SHA-256 校验防止被篡改
        for mirror in ["https://gh-proxy.com/", "https://ghfast.top/"] {
            candidates.push(format!("{}{}", mirror, download_url));
        }
    }
    let target = file.clone();
    tokio::spawn(async move {
        let mut last_error = String::new();
        for url in candidates {
            set_download(|s| {
                s.downloaded = 0;
                s.total = 0;
                s.percent = 0.0;
            });
            match download_file(&url, &target, &digest).await {
                Ok(()) => return,
                Err(error) => {
                    last_error = error;
                    let _ = tokio::fs::remove_file(&target).await;
                }
            }
        }
        set_download(|s| {
            s.state = "error".into();
            s.error = last_error;
        });
    });
    Ok(get_download_status())
}

fn ps_escape(path: &str) -> String {
    path.replace('\'', "''")
}

/// 生成并启动一个等待当前进程退出的更新脚本，然后退出当前程序。
pub fn install_downloaded_update() -> Result<Value, String> {
    let status = download_state()
        .lock()
        .map_err(|_| "下载状态锁失败".to_string())?
        .clone();
    if status.state != "done" {
        return Err("更新尚未下载完成".into());
    }
    let source = PathBuf::from(&status.path);
    if !source.is_file() {
        return Err("更新文件不存在，请重新下载".into());
    }
    #[cfg(windows)]
    {
        let current = std::env::current_exe().map_err(|e| format!("获取当前程序路径失败: {}", e))?;
        let pid = std::process::id();
        // 单个隐藏的 PowerShell 完成等待/替换/重启，避免旧 .cmd 循环
        // 反复拉起 tasklist/powershell 导致黑窗闪烁
        let script = std::env::temp_dir().join(format!("qoder-switch-update-{}.ps1", pid));
        let src = ps_escape(&source.to_string_lossy());
        let cur = ps_escape(&current.to_string_lossy());
        let content = format!(
            r#"$ErrorActionPreference = 'SilentlyContinue'
while (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 500 }}
Unblock-File -LiteralPath '{src}'
$moved = $false
try {{ Move-Item -LiteralPath '{src}' -Destination '{cur}' -Force -ErrorAction Stop; $moved = $true }} catch {{}}
if ($moved) {{ Start-Process -FilePath '{cur}' }} else {{ Start-Process -FilePath '{src}' }}
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force
"#
        );
        std::fs::write(&script, content).map_err(|e| format!("写入更新脚本失败: {}", e))?;
        use std::os::windows::process::CommandExt;
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("启动更新脚本失败: {}", e))?;
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(500));
            std::process::exit(0);
        });
        Ok(json!({ "ok": true, "script": script.to_string_lossy() }))
    }
    #[cfg(not(windows))]
    {
        Err("仅 Windows 桌面版支持自动替换".into())
    }
}

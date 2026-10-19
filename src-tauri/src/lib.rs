//! Qoder-Switch2api Tauri 应用入口。
//!
//!  - Web 服务（127.0.0.1:8787）：/api/* + 嵌入式前端 dist/
//!  - 反代网关：每档位按配置监听（默认国内 7891 / 国际 7892）
//!  - 开发模式窗口加载 Vite dev server（5173，/api 代理到 8787）

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

pub mod account;
pub mod api;
pub mod chat;
pub mod cosy;
pub mod crypto;
pub mod editions;
pub mod gateway;
pub mod info;
pub mod oauth;
pub mod paths;
pub mod sessions;
pub mod state;
pub mod store;
pub mod switcher;
pub mod usage;

use axum::{
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};
use rust_embed::RustEmbed;
use serde::Serialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::api::create_api_router;
use crate::gateway::create_gateway;
pub use crate::state::{AppState, ProxyConfig};

pub const WEB_PORT: u16 = 8787;

/// 实际绑定的 Web 端口（8787 被占用时自动顺延），以及就绪标志
pub static WEB_PORT_ACTUAL: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(WEB_PORT);
static WEB_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 等待 Web 服务就绪，返回实际端口（最多 ~10 秒）
pub fn wait_web_port() -> u16 {
    for _ in 0..100 {
        if WEB_READY.load(std::sync::atomic::Ordering::SeqCst) {
            return WEB_PORT_ACTUAL.load(std::sync::atomic::Ordering::SeqCst);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    WEB_PORT_ACTUAL.load(std::sync::atomic::Ordering::SeqCst)
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SwitchJob {
    pub steps: Vec<crate::switcher::SwitchStep>,
    pub done: bool,
    pub error: String,
    pub result: Option<serde_json::Value>,
}

fn switch_jobs() -> &'static Mutex<HashMap<String, SwitchJob>> {
    static JOBS: OnceLock<Mutex<HashMap<String, SwitchJob>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn switch_job_sender() -> &'static Mutex<HashMap<String, SwitchJob>> {
    switch_jobs()
}

fn proxy_servers() -> &'static Mutex<HashMap<String, Arc<tokio::task::JoinHandle<()>>>> {
    static SERVERS: OnceLock<Mutex<HashMap<String, Arc<tokio::task::JoinHandle<()>>>>> = OnceLock::new();
    SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn proxy_running(edition: &str) -> bool {
    let servers = proxy_servers().lock().unwrap_or_else(|e| e.into_inner());
    servers.contains_key(edition)
}

/// 按设置启动 / 停止反代服务器
pub async fn refresh_proxy_servers(state: &Arc<AppState>) {
    let settings = state.settings.read().await;
    let mut servers = proxy_servers().lock().unwrap_or_else(|e| e.into_inner());
    for value in crate::editions::EDITION_LIST {
        let config: ProxyConfig = settings
            .proxy
            .get(value)
            .cloned()
            .unwrap_or_else(|| ProxyConfig {
                listen: if value == "international" { "127.0.0.1:7892".into() } else { "127.0.0.1:7891".into() },
                ..Default::default()
            });
        let running = servers.contains_key(value);
        if config.enabled && !running {
            let (host, port) = parse_listen(&config.listen);
            let app = create_gateway(value, state.clone());
            let edition_value = value.to_string();
            let handle = tokio::spawn(async move {
                let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("[proxy:{}] 监听失败 {}:{} — {}", edition_value, host, port, e);
                        return;
                    }
                };
                println!("[proxy:{}] 反代已启动 → http://{}:{}/v1", edition_value, host, port);
                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("[proxy:{}] 服务退出: {}", edition_value, e);
                }
            });
            servers.insert(value.to_string(), Arc::new(handle));
        } else if !config.enabled && running {
            if let Some(handle) = servers.remove(value) {
                handle.abort();
            }
            println!("[proxy:{}] 已停止", value);
        }
    }
}

fn parse_listen(listen: &str) -> (String, u16) {
    let parts: Vec<&str> = listen.split(':').collect();
    if parts.len() == 2 {
        (parts[0].to_string(), parts[1].parse().unwrap_or(7891))
    } else {
        ("127.0.0.1".to_string(), listen.parse().unwrap_or(7891))
    }
}

#[derive(RustEmbed)]
#[folder = "../dist"]
struct Assets;

/// 启动 Web 服务（API + 嵌入式前端）
pub async fn start_web_server(state: Arc<AppState>) {
    let app = Router::new()
        .nest("/api", create_api_router(state.clone()))
        .fallback(static_handler);
    // 端口被占用（例如本机其他工具占了 8787）时自动顺延到备用端口
    let candidates = [WEB_PORT, 18787, 28787, 38787, 48787];
    let mut listener = None;
    let mut bound_port = WEB_PORT;
    for port in candidates {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => {
                listener = Some(l);
                bound_port = port;
                break;
            }
            Err(e) => {
                eprintln!("端口 {} 被占用（{}），尝试下一个候选端口", port, e);
            }
        }
    }
    let Some(listener) = listener else {
        eprintln!("Web 服务所有候选端口均被占用，无法启动");
        return;
    };
    WEB_PORT_ACTUAL.store(bound_port, std::sync::atomic::Ordering::SeqCst);
    WEB_READY.store(true, std::sync::atomic::Ordering::SeqCst);
    println!("Qoder-Switch2api WebUI → http://127.0.0.1:{}", bound_port);
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("Web 服务退出: {}", e);
    }
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(content) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream().to_string();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .body(axum::body::Body::from(content.data.into_owned()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    // SPA fallback
    if let Some(content) = Assets::get("index.html") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .body(axum::body::Body::from(content.data.into_owned()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    (StatusCode::NOT_FOUND, "前端尚未构建（npm run build）").into_response()
}

/// 自动签到调度
async fn schedule_auto_checkin(state: Arc<AppState>) {
    let mut last_day = String::new();
    loop {
        let (enabled, hour) = {
            let settings = state.settings.read().await;
            (settings.auto_checkin.enabled, settings.auto_checkin.hour)
        };
        if enabled {
            let now = chrono_lite_now();
            let today = format!("{:04}-{:02}-{:02}", now.0, now.1, now.2);
            if now.3 as i64 == hour && last_day != today {
                last_day = today;
                run_checkin_all(&state).await;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(30 * 60)).await;
    }
}

fn chrono_lite_now() -> (i64, i64, i64, i64) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs / 86400;
    let rem = secs % 86400;
    let (y, m, d) = civil_from_days(days);
    (y, m, d, rem / 3600)
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

async fn run_checkin_all(state: &Arc<AppState>) {
    use crate::info;
    use crate::store::append_jsonl;
    let accounts_snapshot = state.accounts.read().await.accounts.clone();
    for account in accounts_snapshot {
        if account.status == "disabled" {
            continue;
        }
        let edition = state.effective_edition(&account.edition).await;
        match info::list_campaigns(&edition, &account).await {
            Ok(campaigns) => {
                if info::today_checked_in(&campaigns) {
                    continue;
                }
                if let Some(claimable) = info::find_claimable_checkin(&campaigns) {
                    let id = claimable.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    if let Err(e) = info::claim_campaign(&edition, &account, id).await {
                        append_jsonl(
                            "checkin.jsonl",
                            &serde_json::json!({ "accountId": account.id, "edition": account.edition, "result": "error", "auto": true, "error": e }),
                        );
                    } else {
                        append_jsonl(
                            "checkin.jsonl",
                            &serde_json::json!({ "accountId": account.id, "edition": account.edition, "result": "success", "auto": true }),
                        );
                        println!("[auto-checkin] {} 签到成功", account.name);
                    }
                }
            }
            Err(e) => {
                append_jsonl(
                    "checkin.jsonl",
                    &serde_json::json!({ "accountId": account.id, "edition": account.edition, "result": "error", "auto": true, "error": e }),
                );
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new();
    let state_for_server = state.clone();
    let state_for_checkin = state.clone();

    tauri::Builder::default()
        .setup(move |app| {
            // 启动 Web 服务（tokio 运行时由 Tauri 提供）
            let handle = app.handle();
            tauri::async_runtime::spawn(async move {
                refresh_proxy_servers(&state_for_server).await;
                start_web_server(state_for_server).await;
            });
            tauri::async_runtime::spawn(async move {
                schedule_auto_checkin(state_for_checkin).await;
            });

            // 等待 Web 服务就绪（最多 10 秒），避免窗口白屏
            let _ = wait_web_port();

            // 创建窗口：开发模式指向 Vite dev server，生产模式指向本地 Web 服务
            let url = if cfg!(debug_assertions) {
                "http://localhost:5173".to_string()
            } else {
                format!("http://127.0.0.1:{}", wait_web_port())
            };
            let parsed: url::Url = url.parse().expect("window url");
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Qoder-Switch2api")
                .inner_size(1280.0, 860.0)
                .min_inner_size(960.0, 640.0)
                .center()
                .build();
            if let Err(e) = window {
                eprintln!("创建窗口失败: {}", e);
            }
            let _ = handle;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

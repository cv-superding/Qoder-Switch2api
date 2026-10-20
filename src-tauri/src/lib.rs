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
pub mod http;
pub mod info;
pub mod oauth;
pub mod paths;
pub mod sessions;
pub mod state;
pub mod store;
pub mod switcher;
pub mod update;
pub mod usage;

use axum::{
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};
use rust_embed::RustEmbed;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use crate::api::create_api_router;
use crate::gateway::create_gateway;
pub use crate::state::{AppState, ProxyConfig};

pub const WEB_PORT: u16 = 8787;

/// 关闭窗口时是否隐藏到托盘（可在设置中修改）
pub static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);
/// 托盘创建成功后才允许隐藏窗口，避免托盘创建失败时窗口无法找回
static TRAY_READY: AtomicBool = AtomicBool::new(false);

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

fn proxy_signatures() -> &'static Mutex<HashMap<String, String>> {
    static SIGNATURES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    SIGNATURES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn proxy_errors() -> &'static Mutex<HashMap<String, String>> {
    static ERRORS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    ERRORS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn proxy_running(edition: &str) -> bool {
    let servers = proxy_servers().lock().unwrap_or_else(|e| e.into_inner());
    servers.contains_key(edition)
}

pub fn proxy_error(edition: &str) -> String {
    proxy_errors()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(edition)
        .cloned()
        .unwrap_or_default()
}

fn stop_proxy(value: &str) {
    if let Some(handle) = proxy_servers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(value)
    {
        handle.abort();
        println!("[proxy:{}] 已停止", value);
    }
    proxy_signatures()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(value);
    proxy_errors()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(value);
}

/// 按设置启动 / 停止反代服务器
pub async fn refresh_proxy_servers(state: &Arc<AppState>) {
    let settings = state.settings.read().await.clone();
    for value in crate::editions::EDITION_LIST {
        let config: ProxyConfig = settings
            .proxy
            .get(value)
            .cloned()
            .unwrap_or_else(|| ProxyConfig {
                listen: if value == "international" { "127.0.0.1:7892".into() } else { "127.0.0.1:7891".into() },
                ..Default::default()
            });
        let signature = format!("{}|{}", config.enabled, config.listen);
        let running = proxy_servers()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(value);
        let unchanged = proxy_signatures()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(value)
            .map(|current| current == &signature)
            .unwrap_or(false);
        if config.enabled {
            if running && unchanged {
                continue;
            }
            if running {
                stop_proxy(value);
            }
            let (host, port) = parse_listen(&config.listen);
            let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
                Ok(listener) => listener,
                Err(e) => {
                    let message = format!("{}:{} 监听失败：{}", host, port, e);
                    eprintln!("[proxy:{}] {}", value, message);
                    proxy_signatures()
                        .lock()
                        .unwrap_or_else(|err| err.into_inner())
                        .remove(value);
                    proxy_errors()
                        .lock()
                        .unwrap_or_else(|err| err.into_inner())
                        .insert(value.to_string(), message);
                    continue;
                }
            };
            proxy_errors()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(value);
            proxy_signatures()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(value.to_string(), signature);
            let app = create_gateway(value, state.clone());
            let edition_value = value.to_string();
            let log_host = host.clone();
            let handle = tokio::spawn(async move {
                println!("[proxy:{}] 反代已启动 → http://{}:{}/v1", edition_value, log_host, port);
                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("[proxy:{}] 服务退出: {}", edition_value, e);
                }
            });
            proxy_servers()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(value.to_string(), Arc::new(handle));
        } else {
            if running {
                stop_proxy(value);
            }
            proxy_errors()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(value);
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

/// 自动签到调度（本地时区；启动时若已过执行时间会当天补签）
async fn schedule_auto_checkin(state: Arc<AppState>) {
    use chrono::Timelike;
    let mut last_day = String::new();
    loop {
        let (enabled, hour) = {
            let settings = state.settings.read().await;
            (settings.auto_checkin.enabled, settings.auto_checkin.hour)
        };
        if enabled {
            let now = chrono::Local::now();
            let today = now.format("%Y-%m-%d").to_string();
            if now.hour() as i64 >= hour && last_day != today {
                // 有账号失败时不盖章，10 分钟后的下一轮继续重试
                if run_checkin_all(&state).await {
                    last_day = today;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(10 * 60)).await;
    }
}

/// 返回是否所有账号都处理成功；失败时调用方会在下一轮重试
async fn run_checkin_all(state: &Arc<AppState>) -> bool {
    use crate::info;
    use crate::store::append_jsonl;
    let accounts_snapshot = state.accounts.read().await.accounts.clone();
    let mut failed = false;
    for account in accounts_snapshot {
        if account.status == "disabled" {
            continue;
        }
        let edition = state.effective_edition(&account.edition).await;
        match info::list_campaigns(&edition, &account).await {
            Ok(campaigns) => {
                let claimables = info::find_claimable_checkins(&campaigns);
                if claimables.is_empty() {
                    continue;
                }
                for claimable in &claimables {
                    let id = claimable.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    if let Err(e) = info::claim_campaign(&edition, &account, id).await {
                        failed = true;
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
                failed = true;
                append_jsonl(
                    "checkin.jsonl",
                    &serde_json::json!({ "accountId": account.id, "edition": account.edition, "result": "error", "auto": true, "error": e }),
                );
            }
        }
    }
    !failed
}

fn show_main_window<R: tauri::Runtime, M: Manager<R>>(manager: &M) {
    if let Some(window) = manager.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::new();
    let close_to_tray = state
        .settings
        .try_read()
        .map(|settings| settings.close_to_tray)
        .unwrap_or(true);
    CLOSE_TO_TRAY.store(close_to_tray, Ordering::SeqCst);
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
                .inner_size(1100.0, 740.0)
                .min_inner_size(900.0, 600.0)
                .center()
                .build();
            match window {
                Ok(window) => {
                    let win = window.clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            if CLOSE_TO_TRAY.load(Ordering::SeqCst) && TRAY_READY.load(Ordering::SeqCst) {
                                // 关闭窗口 = 收进托盘，Web 服务与反代继续运行
                                api.prevent_close();
                                let _ = win.hide();
                            }
                        }
                    });
                }
                Err(e) => eprintln!("创建窗口失败: {}", e),
            }

            // 系统托盘：显示主窗口 / 退出
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>);
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>);
            if let (Ok(show_item), Ok(quit_item)) = (show_item, quit_item) {
                if let Ok(menu) = Menu::with_items(app, &[&show_item, &quit_item]) {
                    let mut tray = TrayIconBuilder::with_id("main")
                        .menu(&menu)
                        .tooltip("Qoder-Switch2api")
                        .show_menu_on_left_click(false)
                        .on_menu_event(|app, event| match event.id.as_ref() {
                            "show" => show_main_window(app),
                            "quit" => app.exit(0),
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                show_main_window(tray.app_handle());
                            }
                        });
                    if let Some(icon) = app.default_window_icon().cloned() {
                        tray = tray.icon(icon);
                    }
                    match tray.build(app) {
                        Ok(_) => TRAY_READY.store(true, Ordering::SeqCst),
                        Err(e) => {
                            TRAY_READY.store(false, Ordering::SeqCst);
                            eprintln!("创建系统托盘失败: {}", e);
                        }
                    }
                }
            }
            let _ = handle;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

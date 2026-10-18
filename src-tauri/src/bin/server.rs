//! 独立服务模式：不起桌面窗口，只跑 Web 服务 + 反代（等价于 Node 版 npm start）。
//! 构建：cargo build --bin qoder-server

#[tokio::main]
async fn main() {
    let state = qoder_switch2api_lib::AppState::new();
    qoder_switch2api_lib::refresh_proxy_servers(&state).await;
    qoder_switch2api_lib::start_web_server(state).await;
}
